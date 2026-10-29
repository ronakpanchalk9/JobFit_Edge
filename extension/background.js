importScripts('matcher.js');

const MATCH_URL = 'http://127.0.0.1:8766/api/match';

async function runMatch(request) {
  await chrome.storage.local.set({ isMatching: true, lastMatch: null, lastMatchStatus: 'Analyzing with OpenAI…' });
  let result, source = 'openai', status = 'Match results from OpenAI.';
  try {
    const response = await fetch(MATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: request.resume, job_description: request.jobDescription }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `AI helper returned HTTP ${response.status}.`);
    if (!data.ai_enabled || !Array.isArray(data.matched_skills) || !Array.isArray(data.missing_skills) || !data.ai_summary) {
      throw new Error('OpenAI returned incomplete match data.');
    }
    result = data;
  } catch (error) {
    source = 'local';
    result = JobFitMatcher.localMatch(request.resume, request.jobDescription);
    status = `API unavailable; showing local estimate. ${error.message || 'Could not reach the AI helper.'}`;
  }
  try {
    await JobFitMatcher.appendGapCsv(request.companyName, result, request.analysisId);
  } catch (_error) {
    status += ' Gap CSV could not be updated; the extension still has its local gap history.';
  }
  const gapHistory = await JobFitMatcher.saveGapRecord(request.companyName, result, request.analysisId);
  await chrome.storage.local.set({ isMatching: false, lastMatch: result, lastMatchSource: source, lastMatchStatus: status, gapHistory });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'match-job') return;
  runMatch(message).catch(async error => {
    const result = JobFitMatcher.localMatch(message.resume || '', message.jobDescription || '');
    await chrome.storage.local.set({ isMatching: false, lastMatch: result, lastMatchSource: 'local', lastMatchStatus: `API unavailable; showing local estimate. ${error.message || 'Could not complete analysis.'}` });
  });
  sendResponse({ started: true });
});
