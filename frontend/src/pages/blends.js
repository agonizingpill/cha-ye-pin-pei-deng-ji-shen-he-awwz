import {datetime, esc, field, formData, formEnd, handle, header, memo, panelData, panelFields, panelStrip, percent, status} from '../components.js';
import {GRADE, MODEL_STATE, request, store} from '../store.js';

function shareRow(row = {}) {
  return `<div class="share-row"><label>原料批次<select name="lot" required><option value="">选择原料</option>
    ${store.lots.map(lot => `<option value="${lot.id}" ${lot.id === row.lot_id ? 'selected' : ''}>${esc(lot.cultivar)} · ${esc(lot.code)}</option>`).join('')}</select></label>
    ${field('比例（%）', 'percent', row.percent || '', 'type="number" min="0.01" max="100" step="0.01"')}
    <button type="button" class="quiet remove-share" aria-label="移除此原料">移除</button></div>`;
}

function editor(blend, root, refresh) {
  root.innerHTML = `${header(blend ? '修订拼配配方' : '填写拼配配方', '可以先存草稿，送审前须核对配比合计与每批原料留样。',
    `<a class="button quiet" href="#/blends${blend ? '/' + blend.id : ''}">返回台账</a>`)}
    <form id="recipe-form" class="paper form-stack recipe-form"><div class="two">
    ${field('配方号', 'code', blend?.code, blend ? 'readonly' : 'pattern="[A-Z0-9][A-Z0-9-]{1,39}" placeholder="BL-1121-D"')}
    ${field('拼配名', 'name', blend?.name, 'maxlength="60"')}</div><h2>原料比例</h2>
    <div id="shares">${(blend?.shares || [{}, {}]).map(shareRow).join('')}</div>
    <div class="sum-line"><button type="button" class="quiet" id="add-share">添加原料</button><output id="share-total"></output></div>
    ${memo('拼配意图', blend?.note)}${formEnd('保存配方草稿')}</form>`;
  const form = root.querySelector('#recipe-form');
  const shares = root.querySelector('#shares');
  const update = () => {
    const sum = [...shares.querySelectorAll('[name=percent]')].reduce((count, input) => count + Math.round(Number(input.value) * 100), 0);
    root.querySelector('#share-total').textContent = `配比合计 ${(sum / 100).toFixed(2)}%`;
    root.querySelector('#add-share').disabled = shares.children.length >= 8;
    shares.querySelectorAll('.remove-share').forEach(button => { button.disabled = shares.children.length <= 2; });
  };
  update();
  shares.addEventListener('input', update);
  shares.addEventListener('click', event => {
    if (!event.target.matches('.remove-share')) return;
    event.target.closest('.share-row').remove();
    update();
  });
  root.querySelector('#add-share').addEventListener('click', () => {
    shares.insertAdjacentHTML('beforeend', shareRow());
    update();
  });
  handle(form, element => {
    const {code, name, note} = formData(element);
    const data = {code, name, note, shares: [...shares.children].map(row => {
      const {lot, percent} = formDataFrom(row);
      return {lot_id: Number(lot), percent};
    })};
    return request(blend ? `/blends/${blend.id}` : '/blends', data, blend ? 'PUT' : 'POST');
  }, row => { location.hash = `#/blends/${row.id}`; });
}

function formDataFrom(row) {
  return {lot: row.querySelector('[name=lot]').value, percent: row.querySelector('[name=percent]').value};
}

function evidence(review) {
  const evidence = review.result;
  const meta = `<div class="calibration-line"><span>审核模型 <strong>${esc(review.model_version || '未记录')}</strong></span>
    <span>阈值 v${review.snapshot.policy_version}</span>${review.attempts ? `<span>计算尝试 ${review.attempts} 次</span>` : ''}</div>
    ${review.failure ? `<p class="empty error">失败原因：${esc(review.failure)}</p>` : ''}`;
  if (!evidence) return `<section class="evidence"><h3>模型判级依据</h3>${meta}
    ${review.state === 'failed' ? '' : '<p class="empty">计算排队中，完成后显示复评决定。</p>'}</section>`;
  return `<section class="evidence"><h3>模型判级依据</h3>${meta}<div class="calibration-line">
    <span>最高置信度 <strong>${percent(evidence.confidence)}</strong></span><span>生效阈值 <strong>${percent(evidence.effective_threshold)}</strong></span></div>
    ${evidence.probabilities ? `<div class="grade-bars">${Object.entries(GRADE).map(([key, label]) => `<div><span>${label}</span>
      <meter min="0" max="1" value="${evidence.probabilities[key]}">${percent(evidence.probabilities[key])}</meter><strong>${percent(evidence.probabilities[key])}</strong></div>`).join('')}</div>` :
      '<p class="muted">完成盲复评后显示各等级概率。</p>'}
    <details><summary>冻结输入与模型记录</summary><p class="mono digest">${esc(review.digest)}</p>
    <p>模型 ${esc(evidence.model)} · 种子 ${evidence.seed} · 训练 ${evidence.validation.training_rows} 条 / 验证 ${evidence.validation.validation_rows} 条</p>
    <ul>${review.snapshot.ingredients.map(row => `<li>${esc(row.lot)} · 封签 ${esc(row.seal)} · 审评单 #${row.panel_id}</li>`).join('')}</ul></details></section>`;
}

function reviewActions(blend, user) {
  const {review} = blend;
  const own = user.id === blend.author_id;
  if (!review) return own ? `<form id="review-action" data-action="submit"><p class="muted">送审后锁定配方、原料评分、封签和阈值版本。</p>
    ${formEnd('冻结配方并送审', `<a class="button quiet" href="#/blends/edit-${blend.id}">修订配比</a>`)}</form>` : '';
  const state = review.state;
  if (state === 'approved') return `<a class="button" href="#/samples/blend-${blend.id}">登记成品留样 →</a>`;
  if (state === 'repanel' && user.role === 'operator' && !own) return `<form id="review-action" data-action="repanel" class="form-stack">
    <h3>盲复评</h3>${panelFields(true)}${formEnd('提交独立盲评')}</form>`;
  if (state === 'verify' && user.role === 'operator' && !own) return `<form id="review-action" data-action="verify" class="form-stack">
    ${memo('初审意见')}${formEnd('确认初审等级')}</form>`;
  if (state === 'signoff' && user.role === 'supervisor') return `<form id="review-action" data-action="signoff" class="form-stack">
    ${memo('主管签发意见')}${formEnd('签发等级')}</form>`;
  if (state === 'failed' && user.role === 'supervisor') return `<form id="review-action" data-action="retry">${formEnd('按原快照重试')}</form>`;
  return own && ['repanel', 'verify'].includes(state) ? '<p class="empty">等待另一位评审员处理。配方作者不可审核自己的配方。</p>' : '';
}

function blendDetail(blend) {
  const {review} = blend;
  const total = blend.shares.reduce((sum, row) => sum + Math.round(Number(row.percent) * 100), 0) / 100;
  return `<article class="paper blend-detail"><div class="blend-heading"><div><span class="mono">${esc(blend.code)} / V${blend.revision}</span>
    <h2>${esc(blend.name)}</h2></div>${status(review?.state)}</div><blockquote>${esc(blend.note)}</blockquote>
    <section class="blend-formula"><h3>配方组成 <small>合计 ${total.toFixed(2)}%</small></h3>
    <div class="ratio-band" aria-hidden="true">${blend.shares.map(row => `<div style="flex:${Number(row.percent)}"></div>`).join('')}</div>
    <ul>${blend.shares.map(row => `<li><strong>${esc(row.cultivar)}</strong><a href="#/lots/${row.lot_id}">${esc(row.code)}</a>
      <span>${esc(row.percent)}%</span>${!review ? status(row.lot_state) : ''}</li>`).join('')}</ul></section>
    ${review ? `${evidence(review)}${review.repanel ? `<section><h3>独立复评 · ${esc(review.repanel.author)}</h3>
      ${panelStrip(review.repanel)}<blockquote>${esc(review.repanel.note)}</blockquote><p>${GRADE[review.repanel.grade]}</p></section>` : ''}
      ${review.verified_by ? `<p class="muted">初审 ${esc(review.verified_by)}${review.signed_by ? ` · 主管 ${esc(review.signed_by)}` : ''}</p>` : ''}
      ${review.final_grade ? `<div class="issued"><span>已签发等级</span><strong>${GRADE[review.final_grade]}</strong></div>` : ''}` : ''}
    ${reviewActions(blend, store.session.user)}</article>`;
}

function policy(root, refresh) {
  const editable = store.session.user.role === 'supervisor';
  root.innerHTML = `${header('判级阈值版本', '新版本在下次送审时生效。已排队及已签发审核保留原版本。',
    `<div class="header-actions"><a class="button quiet" href="#/blends/models">模型版本</a><a class="button quiet" href="#/blends">返回拼配台账</a></div>`)}
    <div class="work-grid"><section class="paper"><h2>发布记录</h2><ul class="policies">${store.thresholds.map(row =>
      `<li><span class="mono">V${row.id}</span><strong>${percent(row.floor)}</strong><span>${esc(row.reason)} <small>${esc(row.author)}</small></span></li>`).join('') || '<li>等待主管发布首个阈值。</li>'}</ul></section>
      ${editable ? `<form id="policy-form" class="paper form-stack"><h2>发布新阈值</h2><p class="muted">最终生效值取策略阈值和验证集校准值中的较高值。</p>
       ${field('策略阈值（0.500–0.990）', 'floor', '', 'type="number" min="0.5" max="0.99" step="0.001"')}${memo('变更理由')}${formEnd('发布版本')}</form>` : ''}</div>`;
  const form = root.querySelector('#policy-form');
  if (form) handle(form, item => request('/thresholds', formData(item)), () => refresh('新版阈值已发布。'));
}

function metricLine(metrics) {
  return `<div class="calibration-line"><span>校准 <strong>${metrics.calibrated ? '达标' : '未达标'}</strong></span>
    <span>验证准确率 <strong>${percent(metrics.accuracy)}</strong></span>
    ${metrics.calibrated ? `<span>保留覆盖率 <strong>${percent(metrics.coverage)}</strong></span>
    <span>保留集正确率 <strong>${percent(metrics.accepted_accuracy)}</strong></span>
    <span>校准阈值 <strong>${percent(metrics.calibrated_floor)}</strong></span>` : ''}
    <span>训练 ${metrics.training_rows} 条 / 校准 ${metrics.validation_rows} 条</span></div>`;
}

function modelRow(row, editable) {
  const metrics = row.metrics || {};
  const comparison = row.comparison;
  const candidate = comparison?.candidate_metrics || {};
  const incumbent = comparison?.incumbent_metrics || {};
  return `<li class="model-entry"><div class="blend-heading"><div><span class="mono">${esc(row.label)}</span>
    <span class="status ${row.state === 'active' ? 'good' : row.state === 'candidate' ? 'warn' : ''}">${MODEL_STATE[row.state]}</span></div>
    <small>${esc(row.author)} · ${datetime(row.created_at)}${row.published_at ? ` · 发布于 ${datetime(row.published_at)}` : ''}</small></div>
    ${metricLine(metrics)}
    ${comparison ? `<p class="muted">与现用 ${esc(comparison.incumbent_label)} 用同一批 ${comparison.calibration_rows} 条校准样本比较（${datetime(comparison.compared_at)}）：
      候选保留正确率 ${candidate.calibrated ? percent(candidate.accepted_accuracy) : '—'} · 覆盖率 ${candidate.calibrated ? percent(candidate.coverage) : '—'}；
      现用保留正确率 ${incumbent.calibrated ? percent(incumbent.accepted_accuracy) : '—'} · 覆盖率 ${incumbent.calibrated ? percent(incumbent.coverage) : '—'}。</p>` :
      '<p class="muted">首个模型版本，无对照记录。</p>'}
    ${row.stale ? '<p class="empty error">现用模型已更换，发布前须用同一批校准样本重新比较。</p>' : ''}
    ${row.state === 'candidate' && !metrics.calibrated ? '<p class="empty">校准未达标，不能发布。</p>' : ''}
    ${editable && row.state === 'candidate' && metrics.calibrated && !row.stale ?
      `<form class="model-action" data-action="publish" data-id="${row.id}">${formEnd(`发布 ${esc(row.label)} 为现用模型`)}</form>` : ''}
    ${editable && row.state === 'candidate' && row.stale ?
      `<form class="model-action" data-action="compare" data-id="${row.id}">${formEnd('按当前现用模型重新比较')}</form>` : ''}
    <details><summary>训练参数</summary><p class="mono digest">${esc(JSON.stringify(row.parameters))}</p></details></li>`;
}

function models(root, refresh) {
  const editable = store.session.user.role === 'supervisor';
  root.innerHTML = `${header('判级模型版本', '候选模型与现用模型用同一批校准样本比较；校准达标且比较未过期才可发布。已送审的审核单仍按送审时生效的模型计算。',
    `<div class="header-actions"><a class="button quiet" href="#/blends/policy">阈值版本</a><a class="button quiet" href="#/blends">返回拼配台账</a></div>`)}
    <div class="work-grid"><section class="paper"><h2>版本记录</h2><ul class="model-list">${store.models.map(row => modelRow(row, editable)).join('') || '<li>等待主管训练首个模型。</li>'}</ul></section>
    ${editable ? `<form id="model-form" class="paper form-stack"><h2>训练候选模型</h2>
      <p class="muted">校准样本固定为同一批验证集；达标线：保留至少 25 条且保留集正确率至少 90%。</p>
      ${field('树数量（10–400）', 'n_estimators', '70', 'type="number" min="10" max="400" step="1"')}
      ${field('最大深度（1–6）', 'max_depth', '2', 'type="number" min="1" max="6" step="1"')}
      ${field('学习率（0.01–1.00）', 'learning_rate', '0.09', 'type="number" min="0.01" max="1" step="0.01"')}
      ${field('随机种子（0–9999）', 'random_state', '67', 'type="number" min="0" max="9999" step="1"')}
      ${formEnd('训练并与现用模型比较')}</form>` : ''}</div>`;
  const form = root.querySelector('#model-form');
  if (form) handle(form, item => {
    const data = formData(item);
    for (const key of ['n_estimators', 'max_depth', 'random_state', 'learning_rate']) data[key] = Number(data[key]);
    return request('/models/compare', data);
  }, () => refresh('候选模型已训练并完成比较。'));
  root.querySelectorAll('.model-action').forEach(action => handle(action, item =>
    request(`/models/${item.dataset.id}/${item.dataset.action}`, {}), () => refresh('模型版本已更新。')));
}

export function blends(root, id, refresh) {
  const user = store.session.user;
  if (id === 'policy') return policy(root, refresh);
  if (id === 'models') return models(root, refresh);
  const edit = typeof id === 'string' && id.startsWith('edit-') ? store.blends.find(row => row.id === Number(id.slice(5))) : null;
  if (user.role === 'operator' && (id === 'new' || edit?.author_id === user.id && !edit.review)) return editor(edit, root, refresh);
  const selected = store.blends.find(row => row.id === id) || store.blends[0];
  root.innerHTML = `${header('拼配等级审核', '查看配方组成、盲复评队列及双人签发记录。', `<div class="header-actions">
    <a class="button quiet" href="#/blends/models">模型版本</a><a class="button quiet" href="#/blends/policy">阈值版本</a>${user.role === 'operator' ? '<a class="button" href="#/blends/new">新建拼配</a>' : ''}</div>`)}
    <div class="review-grid"><aside class="paper review-index"><h2>拼配台账</h2><ul>${store.blends.map(row =>
      `<li><a class="${row.id === selected?.id ? 'active' : ''}" href="#/blends/${row.id}"><span><small>${esc(row.code)}</small>
      <strong>${esc(row.name)}</strong></span>${status(row.review?.state)}</a></li>`).join('') || '<li class="empty">新建首个拼配配方。</li>'}</ul></aside>
    ${selected ? blendDetail(selected) : ''}</div>`;
  const action = root.querySelector('#review-action');
  if (!action) return;
  handle(action, form => {
    const kind = form.dataset.action;
    if (kind === 'submit') return request(`/blends/${selected.id}/review`, {});
    const data = kind === 'repanel' ? panelData(form) : formData(form);
    return request(`/reviews/${selected.review.id}/${kind}`, data);
  }, () => refresh('审核记录已更新。'));
}
