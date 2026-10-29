const jdEl = document.querySelector('#description');
const scanBtn = document.querySelector('#scan');
const refreshResumeBtn = document.querySelector('#refresh-resume');
const resumeStatus = document.querySelector('#resume-status');
const resumeName = document.querySelector('#resume-name');
const analyzeBtn = document.querySelector('#analyze');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const minimumYoeEl = document.querySelector('#minimum-yoe');
const candidateYoeEl = document.querySelector('#candidate-yoe');
let resumeText = '';

function setStatus(message = '', error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}
function displayYears(element, years) {
  element.textContent = years == null ? 'Not detected' : `${years} ${years === 1 ? 'year' : 'years'}`;
}
function showDetectedYears() {
  if (!resultEl.hidden) return;
  displayYears(minimumYoeEl, JobFitMatcher.minimumYears(jdEl.value));
  displayYears(candidateYoeEl, JobFitMatcher.candidateYears(resumeText));
}
function renderResult(data) {
  document.querySelector('#score').textContent = data.overall_score;
  document.querySelector('#skill-score').textContent = `${data.skill_score}%`;
  document.querySelector('#experience-score').textContent = data.experience_score == null ? 'Not stated' : `${data.experience_score}%`;
  document.querySelector('#verdict').textContent = data.verdict;
  document.querySelector('#matched').textContent = data.matched_skills.length ? data.matched_skills.join(', ') : 'No direct skills from the matcher were found.';
  document.querySelector('#missing').textContent = data.missing_skills.length ? data.missing_skills.join(', ') : 'No listed skills appear to be missing.';
  const note = document.querySelector('#ai-note');
  note.hidden = !data.ai_summary;
  note.textContent = data.ai_summary || '';
  displayYears(minimumYoeEl, data.minimum_years_required);
  displayYears(candidateYoeEl, data.candidate_years_experience);
  resultEl.hidden = false;
}
function applyState(state) {
  if (state.lastMatch) renderResult(state.lastMatch);
  else resultEl.hidden = true;
  const working = Boolean(state.isMatching);
  analyzeBtn.disabled = working;
  setStatus(working ? (state.lastMatchStatus || 'Analyzing…') : (state.lastMatchStatus || ''), !working && String(state.lastMatchStatus || '').startsWith('API unavailable'));
}
async function saveDraft() {
  await chrome.storage.local.set({ description: jdEl.value });
}
async function loadSavedResume(quiet = false) {
  refreshResumeBtn.disabled = true;
  if (!quiet) resumeStatus.textContent = 'Loading the resume from the Resume folder…';
  try {
    const response = await fetch('http://127.0.0.1:8766/api/resume');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || 'Could not load the resume.');
    resumeText = data.text;
    resumeName.textContent = data.filename;
    resumeStatus.textContent = `Ready · updated ${new Date(data.modified).toLocaleDateString()}`;
    await chrome.storage.local.set({ resume: resumeText, resumeFilename: data.filename, resumeModified: data.modified });
    showDetectedYears();
    return true;
  } catch (error) {
    if (!error.message.includes('Failed to fetch')) {
      resumeName.textContent = 'Resume folder';
      resumeStatus.textContent = error.message;
      resumeText = '';
      await chrome.storage.local.set({ resume: '', resumeFilename: '' });
      if (!quiet) setStatus(error.message, true);
      return false;
    }
    const saved = await chrome.storage.local.get(['resume', 'resumeFilename']);
    resumeText = saved.resume || '';
    resumeName.textContent = saved.resumeFilename || 'Resume folder';
    resumeStatus.textContent = resumeText ? 'Using saved copy · start helper and refresh to check for updates.' : 'Add one resume file to Resume, then start the local helper.';
    showDetectedYears();
    if (!quiet) setStatus('Start the local helper to load the Resume folder.', true);
    return Boolean(resumeText);
  } finally { refreshResumeBtn.disabled = false; }
}

jdEl.addEventListener('input', () => {
  saveDraft(); showDetectedYears(); resultEl.hidden = true;
  chrome.storage.local.set({ lastMatch: null, lastMatchStatus: '', lastMatchSource: '' });
});
refreshResumeBtn.addEventListener('click', () => loadSavedResume());
scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  setStatus('Looking for the job description on this page…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a job posting in a regular browser tab first.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const selectors = ['[data-job-description]', '[data-testid*="jobDescription"]', '[class*="jobDescription"]', '[class*="job-description"]', '#jobDescriptionText', '.description__text', '.show-more-less-html__markup', '[class*="description"]', 'article', 'main'];
      const candidates = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).map(el => (el.innerText || '').trim()).filter(text => text.length > 400);
      return { title: document.title, text: (candidates.sort((a,b) => a.length - b.length)[0] || document.body?.innerText || '').slice(0, 24000) };
    }});
    if (!result?.text || result.text.length < 150) throw new Error('Could not find enough job text. Copy the description into the field instead.');
    jdEl.value = result.text;
    await saveDraft();
    showDetectedYears();
    resultEl.hidden = true;
    await chrome.storage.local.set({ lastMatch: null, lastMatchStatus: '', lastMatchSource: '' });
    setStatus(`Scanned ${result.title || 'the page'}. Review the text, then check your fit.`);
  } catch (error) { setStatus(error.message || 'Could not scan this page.', true); }
  finally { scanBtn.disabled = false; }
});

analyzeBtn.addEventListener('click', async () => {
  if (!resumeText) await loadSavedResume(true);
  if (!resumeText || !jdEl.value.trim()) {
    setStatus(!resumeText ? 'No resume is loaded. Add one file to the Resume folder and start the local helper.' : 'Add a job description to continue.', true);
    return;
  }
  resultEl.hidden = true;
  analyzeBtn.disabled = true;
  setStatus('Starting analysis…');
  try {
    await chrome.runtime.sendMessage({ type: 'match-job', resume: resumeText, jobDescription: jdEl.value.trim() });
  } catch (error) {
    try {
      const response = await fetch('http://127.0.0.1:8766/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume: resumeText, job_description: jdEl.value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `AI helper returned HTTP ${response.status}.`);
      if (!data.ai_enabled || !Array.isArray(data.matched_skills) || !Array.isArray(data.missing_skills) || !data.ai_summary) throw new Error('OpenAI returned incomplete match data.');
      renderResult(data);
      const message = 'Match results from OpenAI.';
      setStatus(message);
      await chrome.storage.local.set({ isMatching: false, lastMatch: data, lastMatchSource: 'openai', lastMatchStatus: message });
    } catch (apiError) {
      const result = JobFitMatcher.localMatch(resumeText, jdEl.value.trim());
      renderResult(result);
      const message = `API unavailable; showing local estimate. ${apiError.message || error.message || 'Could not complete analysis.'}`;
      setStatus(message, true);
      await chrome.storage.local.set({ isMatching: false, lastMatch: result, lastMatchSource: 'local', lastMatchStatus: message });
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.lastMatch && !changes.lastMatchStatus && !changes.isMatching)) return;
  chrome.storage.local.get(['lastMatch', 'lastMatchStatus', 'isMatching']).then(applyState);
});

chrome.storage.local.get(['resume', 'resumeFilename', 'description', 'lastMatch', 'lastMatchStatus', 'isMatching']).then(state => {
  resumeText = state.resume || '';
  resumeName.textContent = state.resumeFilename || 'Resume folder';
  jdEl.value = state.description || '';
  applyState(state);
  showDetectedYears();
  loadSavedResume(true);
});
