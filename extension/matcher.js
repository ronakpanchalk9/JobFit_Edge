globalThis.JobFitMatcher = (() => {
  const commonSkills = `javascript typescript python java c c++ c# go rust ruby php swift kotlin sql mysql postgresql mongodb redis aws azure gcp docker kubernetes terraform linux git ci/cd react angular vue node.js node express django flask fastapi spring .net machine learning deep learning nlp llm generative ai data analysis data science pandas numpy tensorflow pytorch spark tableau power bi excel sales marketing seo sem crm communication leadership project management agile scrum product management user research ux ui figma html css rest api graphql cybersecurity networking accounting finance financial modeling recruiting talent acquisition customer service writing`.split(/ (?=[^ ]+)/);

  function skills(text) {
    const haystack = ` ${String(text).toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ')} `;
    return commonSkills.filter(skill => haystack.includes(` ${skill} `) || haystack.includes(`${skill} `));
  }

  function minimumYears(text) {
    const match = String(text).match(/(?:at\s+least\s+|minimum(?:\s+of)?\s+|more\s+than\s+)?(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:relevant|professional|work)\s+)?experience\b/i)
      || String(text).match(/experience\b[^\n.]{0,50}?(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/i);
    return match ? Number(match[1]) : null;
  }

  function candidateYears(text) {
    const source = String(text);
    const lines = source.split(/\r?\n/);
    const sectionHeading = /^\s*(?:(?:professional|work)\s+)?experience\s*$/i;
    const otherHeading = /^\s*(?:education|projects?|technical skills|skills|certifications?|achievements?|publications?|summary|profile|volunteer experience)\s*$/i;
    const sectionStart = lines.findIndex(line => sectionHeading.test(line));
    const experienceText = sectionStart < 0
      ? source
      : lines.slice(sectionStart + 1, lines.findIndex((line, index) => index > sectionStart && otherHeading.test(line)) < 0
        ? lines.length
        : lines.findIndex((line, index) => index > sectionStart && otherHeading.test(line))).join('\n');
    const explicit = [...experienceText.matchAll(/(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:professional|work)\s+)?experience\b/gi)].map(match => Number(match[1]));
    if (explicit.length) return Math.max(...explicit);
    const monthNames = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
    const monthIndex = month => new Date(`${month} 1, 2000`).getMonth();
    const monthDate = (month, year, end = false) => {
      const m = month ? monthIndex(month) : (end ? 11 : 0);
      return Number(year) * 12 + m + (end ? 1 : 0);
    };
    const ranges = [];
    const dated = new RegExp(`\\b(?:(${monthNames})\\s+)?(19\\d{2}|20\\d{2})\\s*(?:-|–|—|to)\\s*(?:(${monthNames})\\s+)?(19\\d{2}|20\\d{2}|present|current)\\b`, 'gi');
    for (const match of experienceText.matchAll(dated)) {
      const start = monthDate(match[1], match[2]);
      const endYear = /present|current/i.test(match[4]) ? new Date().getFullYear() : match[4];
      const endMonth = /present|current/i.test(match[4]) ? new Date().toLocaleString('en', { month: 'short' }) : match[3];
      const end = monthDate(endMonth, endYear, true);
      if (end > start && end - start <= 600) ranges.push([start, end]);
    }
    if (!ranges.length) return null;
    ranges.sort((a, b) => a[0] - b[0]);
    let total = 0, [start, end] = ranges[0];
    for (const range of ranges.slice(1)) {
      if (range[0] <= end) end = Math.max(end, range[1]);
      else { total += end - start; [start, end] = range; }
    }
    total += end - start;
    return Math.round(total / 6) / 2;
  }

  function localMatch(resume, jd) {
    const resumeSkills = skills(resume), jdSkills = skills(jd);
    const matched = jdSkills.filter(skill => resumeSkills.includes(skill));
    const missing = jdSkills.filter(skill => !resumeSkills.includes(skill));
    const skillScore = jdSkills.length ? Math.round(matched.length / jdSkills.length * 100) : 0;
    const minimum = minimumYears(jd), candidate = candidateYears(resume);
    const experienceScore = minimum == null ? null : (candidate == null ? 0 : minimum <= 0 ? 100 : Math.min(100, Math.round(candidate / minimum * 100)));
    const overall = experienceScore == null ? skillScore : Math.round(skillScore * .4 + experienceScore * .6);
    return {
      overall_score: overall, skill_score: skillScore, experience_score: experienceScore,
      minimum_years_required: minimum, candidate_years_experience: candidate,
      matched_skills: matched, missing_skills: missing,
      verdict: overall >= 75 ? 'Strong match' : overall >= 50 ? 'Possible match' : 'Low match',
      ai_summary: 'Local estimate only; AI analysis was unavailable. Check the detected experience values.',
    };
  }

  async function saveGapRecord(companyName, result, analysisId) {
    const stored = await chrome.storage.local.get('gapHistory');
    const history = Array.isArray(stored.gapHistory) ? stored.gapHistory : [];
    if (history.some(item => item.analysis_id === analysisId)) return history;

    const uniqueGaps = [...new Set((Array.isArray(result.missing_skills) ? result.missing_skills : [])
      .map(gap => String(gap).trim().replace(/[.!?;:]+$/, ''))
      .filter(Boolean))];
    history.unshift({
      analysis_id: analysisId,
      company_name: String(companyName || '').trim() || 'Company not provided',
      gaps: uniqueGaps,
      analyzed_at: new Date().toISOString(),
    });
    const updated = history.slice(0, 500);
    await chrome.storage.local.set({ gapHistory: updated });
    return updated;
  }

  async function appendGapCsv(companyName, result, analysisId) {
    const response = await fetch('http://127.0.0.1:8766/api/gaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis_id: analysisId,
        company_name: String(companyName || '').trim(),
        gaps: Array.isArray(result.missing_skills) ? result.missing_skills : [],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Gap CSV helper returned HTTP ${response.status}.`);
    return data;
  }

  return { skills, minimumYears, candidateYears, localMatch, saveGapRecord, appendGapCsv };
})();
