globalThis.FBPLiveClient = class {
  constructor({ workerUrl, sheetsUrl, fetcher = (...args) => globalThis.fetch(...args), storage = globalThis.sessionStorage, newId = () => crypto.randomUUID() }) {
    this.workerUrl = workerUrl;
    this.sheetsUrl = sheetsUrl;
    this.fetcher = fetcher;
    this.storage = storage;
    this.newId = newId;
    this.state = null;
    this.stateAt = 0;
    this.pendingState = null;
  }

  async owner(force = false) {
    if (!force && this.state && Date.now() - this.stateAt < 15000) return this.state;
    if (!this.pendingState) {
      this.pendingState = this.request(this.workerUrl, 'backend-status').then(state => {
        if (!['SHEETS', 'D1'].includes(state.owner) || !Number.isSafeInteger(state.epoch) || state.epoch < 1) throw new Error('Pool ownership could not be verified. Try again shortly.');
        this.state = state;
        this.stateAt = Date.now();
        return state;
      }).finally(() => { this.pendingState = null; });
    }
    return this.pendingState;
  }

  async request(endpoint, action, parameters = {}, timeout = 30000) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ action, ...parameters, _: String(Date.now()) });
    const response = await this.fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Pool data is unavailable. Try again shortly.');
    return data;
  }

  async read(action, parameters = {}, timeout = 30000) {
    const state = await this.owner();
    const resolvedAction = state.owner === 'D1' && action === 'current-week-race' ? 'race-archive' : action;
    const data = await this.request(state.owner === 'D1' ? this.workerUrl : this.sheetsUrl, resolvedAction, parameters, timeout);
    const current = await this.owner(true);
    if (current.owner !== state.owner || current.epoch !== state.epoch) throw new Error('Pool ownership changed while loading. Refresh before continuing.');
    return data;
  }

  async identity(submission) {
    const state = await this.owner();
    const response = await this.fetcher(state.owner === 'D1' ? this.workerUrl : this.sheetsUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'assess-player-identity', name: submission.name, weekName: submission.weekName }), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Name check failed.');
    return data;
  }

  async existing(submission) {
    const state = await this.owner(true);
    const parameters = { season: submission.season, week: submission.week, phase: submission.phase, name: submission.name };
    if (state.owner === 'D1') {
      const data = await this.request(this.workerUrl, 'existing-submission', parameters);
      return { lookup: data, player: data.exists ? { name: data.name, submittedAt: data.submittedAt, lookupOnly: true } : null };
    }
    const test = submission.mode === 'test';
    const data = await this.request(this.sheetsUrl, test ? 'preseason-test' : 'existing-submission', parameters);
    const player = test ? (data.players || []).find(row => String(row.name).trim().toLowerCase() === submission.name.trim().toLowerCase()) : data.player;
    return { lookup: state, player: player || null };
  }

  async submit(submission, lookup) {
    const state = await this.owner(true);
    if (lookup?.owner !== state.owner || lookup.epoch !== state.epoch) throw new Error('Pool ownership changed. Reload before submitting.');
    let payload = submission;
    const pendingKey = 'fbp-pending-operational-submission';
    if (state.owner === 'D1') {
      if (!state.writesEnabled) throw new Error('Submissions are temporarily paused for maintenance. Your draft is preserved.');
      if (lookup?.owner !== 'D1' || lookup.epoch !== state.epoch || !Object.hasOwn(lookup, 'submissionId')) throw new Error('Pool ownership changed. Reload before submitting.');
      const intent = JSON.stringify(submission);
      const stored = this.storage.getItem(pendingKey);
      const pending = stored ? JSON.parse(stored) : null;
      payload = pending?.intent === intent && pending.payload.expectedEpoch === state.epoch ? pending.payload
        : { ...submission, operationId: this.newId(), expectedSubmissionId: lookup.submissionId, expectedEpoch: state.epoch };
      this.storage.setItem(pendingKey, JSON.stringify({ intent, payload }));
    } else if (lookup?.owner === 'D1') {
      throw new Error('Pool ownership changed. Reload before submitting.');
    }
    const response = await this.fetcher(state.owner === 'D1' ? this.workerUrl : this.sheetsUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Submission failed. Your draft is preserved.');
    if (state.owner === 'D1') this.storage.removeItem(pendingKey);
    return result;
  }
};