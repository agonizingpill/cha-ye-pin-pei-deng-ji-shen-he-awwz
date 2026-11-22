import logging
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException
from redis import RedisError
from sqlalchemy import select

from .constants import ATTRIBUTES, ReviewState as State
from .db import QUEUE, redis
from .grade_model import digest, fit
from .models import (Audit, BlendRecipe, BlendShare, GradeModel, GradeReview, ModelState, RetainedSample,
                    SensoryPanel, TeaLot, ThresholdPolicy)

logger = logging.getLogger(__name__)


def record(db, user, event, subject, explanation):
    db.add(Audit(actor=user.username if hasattr(user, 'username') else user, event=event,
                 subject=str(subject), explanation=explanation))


def require(db, model, key, lock=False):
    row = db.get(model, key, with_for_update=lock)
    if row is None:
        raise HTTPException(404, '记录不存在')
    return row


def sample_for(db, **reference):
    return db.scalar(select(RetainedSample).filter_by(**reference))


def lot_state(db, lot):
    if not lot.panels:
        return 'awaiting_panel'
    if not sample_for(db, lot_id=lot.id):
        return 'awaiting_sample'
    return 'ready'


def replace_shares(db, recipe, data):
    for share in data.shares:
        require(db, TeaLot, share.lot_id)
    incoming = {share.lot_id: share.percent for share in data.shares}
    for existing in list(recipe.shares):
        if existing.lot_id in incoming:
            existing.percent = incoming.pop(existing.lot_id)
        else:
            recipe.shares.remove(existing)
    recipe.shares.extend(BlendShare(lot_id=key, percent=percent) for key, percent in incoming.items())


def latest_policy(db):
    policy = db.scalar(select(ThresholdPolicy).order_by(ThresholdPolicy.id.desc()).limit(1))
    if policy is None:
        raise HTTPException(409, '请主管先登记模型阈值版本')
    return policy


def current_model(db, lock=False):
    state = db.get(ModelState, 1, with_for_update=lock)
    model = db.get(GradeModel, state.active_model_id) if state else None
    if model is None:
        raise HTTPException(409, '请主管先发布判级模型版本')
    return model


def comparison_record(incumbent, candidate_metrics):
    return {'incumbent_id': incumbent.id, 'incumbent_label': incumbent.label,
            'incumbent_metrics': incumbent.metrics, 'candidate_metrics': candidate_metrics,
            'calibration_rows': candidate_metrics['validation_rows'],
            'passed': bool(candidate_metrics.get('calibrated')),
            'compared_at': datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec='seconds')}


def compare_model(db, parameters, user):
    incumbent = current_model(db)
    _, metrics = fit(parameters)
    row = GradeModel(label=f'pending-{uuid4().hex[:16]}', parameters=parameters, metrics=metrics,
                     compared_against_id=incumbent.id, comparison=comparison_record(incumbent, metrics),
                     author_id=user.id)
    db.add(row)
    db.flush()
    row.label = f'wuyi-panel-v{row.id}'
    verdict = '校准达标' if metrics['calibrated'] else '校准未达标'
    record(db, user, 'model.compare', row.label, f'对照 {incumbent.label} · {verdict} · {parameters}')
    return row


def recompare_model(db, row, user):
    if row.published_at is not None:
        raise HTTPException(409, '已发布的模型版本无需重新比较')
    incumbent = current_model(db)
    _, metrics = fit(row.parameters)
    row.metrics = metrics
    row.compared_against_id = incumbent.id
    row.comparison = comparison_record(incumbent, metrics)
    record(db, user, 'model.recompare', row.label, f'对照 {incumbent.label}')
    return row


def publish_model(db, key, user):
    state = db.get(ModelState, 1, with_for_update=True)
    if state is None:
        raise HTTPException(409, '请主管先发布判级模型版本')
    row = require(db, GradeModel, key, lock=True)
    if row.id == state.active_model_id:
        raise HTTPException(409, '该模型版本正在生效')
    if not row.metrics.get('calibrated'):
        raise HTTPException(409, '候选模型校准未达标，不能发布')
    if row.compared_against_id != state.active_model_id:
        raise HTTPException(409, '现用模型已更换，请用同一批校准样本重新比较后再发布')
    row.published_at = datetime.now(timezone.utc).replace(tzinfo=None)
    state.active_model_id = row.id
    record(db, user, 'model.publish', row.label, f'参数 {row.parameters}')
    return row


def freeze(db, recipe):
    total = sum((share.percent for share in recipe.shares), Decimal('0'))
    if total != Decimal('100.00'):
        raise HTTPException(409, f'配比为 {total:.2f}%，必须闭合至 100.00%')
    ingredients = []
    for share in recipe.shares:
        lot = share.lot
        sample = sample_for(db, lot_id=lot.id)
        if sample is None:
            raise HTTPException(409, f'{lot.code} 缺失原料留样，封签登记后再送审')
        if not lot.panels:
            raise HTTPException(409, f'{lot.code} 缺失感官评审，请补录')
        panel = lot.panels[-1]
        ingredients.append({'lot': lot.code, 'percent': str(share.percent), 'seal': sample.seal,
                            'panel_id': panel.id, 'scores': {key: getattr(panel, key) for key in ATTRIBUTES}})
    policy = latest_policy(db)
    model = current_model(db, lock=True)
    snapshot = {'code': recipe.code, 'revision': recipe.revision, 'ingredients': ingredients,
                'policy_version': policy.id, 'policy_floor': str(policy.floor),
                'model_id': model.id, 'model_version': model.label}
    return GradeReview(recipe_id=recipe.id, revision=recipe.revision, threshold_id=policy.id,
                       model_id=model.id, state=State.QUEUED, snapshot=snapshot, digest=digest(snapshot))


def wake(review_id):
    try:
        redis.rpush(QUEUE, review_id)
    except RedisError:
        logger.warning('Redis notification failed for review %s; database polling will recover', review_id)


def expect(review, *states):
    if review.state not in states:
        raise HTTPException(409, f'审核状态 {review.state} 不支持该操作')


def independent(db, review, user):
    recipe = require(db, BlendRecipe, review.recipe_id)
    if recipe.author_id == user.id:
        raise HTTPException(403, '配方作者不能复评或审核自己的配方')
    return recipe


def repanel(db, review, user, data):
    independent(db, review, user)
    expect(review, State.REPANEL)
    db.add(SensoryPanel(review_id=review.id, author_id=user.id, **data.model_dump()))
    review.state = State.VERIFY
    record(db, user, 'panel.recheck', review.id, data.note)


def verify(db, review, user, note):
    independent(db, review, user)
    expect(review, State.VERIFY)
    panel = db.scalar(select(SensoryPanel).filter_by(review_id=review.id))
    review.final_grade = panel.grade if panel else review.result['candidate']
    review.verified_by = user.id
    review.state = State.SIGNOFF
    record(db, user, 'grade.verify', review.id, note)


def approve(db, review, user, note):
    independent(db, review, user)
    expect(review, State.SIGNOFF)
    if review.verified_by == user.id:
        raise HTTPException(403, '签发和初审须由两人分别完成')
    review.signed_by = user.id
    review.state = State.APPROVED
    record(db, user, 'grade.signoff', review.id, note)
