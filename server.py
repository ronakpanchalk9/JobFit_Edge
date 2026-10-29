"""Local resume matcher using LangChain retrieval and OpenAI models."""
import os
import re
from pathlib import Path
from datetime import datetime
import io

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)
app = FastAPI(title="JobFit local helper")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
RESUME_DIR = Path(__file__).resolve().parent / "Resume"
SUPPORTED_RESUME_TYPES = {".pdf", ".docx", ".txt", ".md"}
RESUME_SPLITTER = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=200)


class SkillMatch(BaseModel):
    ai_summary: str = Field(description="One concise sentence, at most 20 words, stating strongest fit and main gap.")
    skill_score: int = Field(ge=0, le=100, description="Evidence-based skill match score from 0 to 100.")
    matched_skills: list[str] = Field(description="At most 6 concise skill or tool names evidenced in the resume and required by the job.")
    missing_skills: list[str] = Field(description="At most 12 concise names of concrete skills, tools, methods, or competencies required by the job but absent from resume evidence. Return labels only, never sentences, experience requirements, or explanations.")


MATCH_PROMPT = ChatPromptTemplate.from_messages([
    ("system", """Compare the resume evidence directly with the job description. Do not invent experience or infer protected traits. The retrieved resume passages are relevant excerpts; treat the full resume only as represented by those excerpts. Score skills from 0 to 100 based on evidence. List at most 6 key items in matched_skills and at most 12 in missing_skills. For missing_skills, return only short labels for concrete skills, tools, methods, or competencies that the job requires and the resume does not evidence. Never put sentences, explanations, years-of-experience requirements, or broad job duties in missing_skills. If a skill is evidenced in the resume, do not list it as missing. The summary must be one concise sentence of at most 20 words stating the strongest fit and main gap; do not repeat scores or list skills. Years of experience is high priority; if candidate experience is below the stated minimum, clearly mention that gap in the summary."""),
    ("human", """Automatically detected experience — minimum required by job: {minimum_years}; candidate experience: {candidate_years}.

Relevant resume excerpts:
{resume_context}

Job description:
{job_description}"""),
])


def extract_minimum_years(job_description: str) -> float | None:
    text = job_description.lower()
    range_match = re.search(r"\b(\d{1,2}(?:\.\d+)?)\s*(?:-|–|—|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:relevant|professional|work)\s+)?experience\b", text)
    if range_match:
        return float(range_match.group(1))
    patterns = [
        r"\b(?:minimum(?: of)?|at least|no less than)\s*(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b",
        r"\b(\d{1,2}(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:relevant|professional|work)\s+)?experience\b",
        r"\b(\d{1,2}(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\b",
        r"\b(\d{1,2}(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:relevant|professional|work)\s+)?experience\s+(?:required|minimum)\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return float(match.group(1))
    for match in re.finditer(r"\b(\d{1,2}(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:relevant|professional|work)\s+)?experience\b", text):
        context = text[max(0, match.start() - 35):match.end() + 25]
        if not re.search(r"preferred|preferably|desirable|nice\s+to\s+have|bonus", context):
            return float(match.group(1))
    return None


def extract_candidate_years(resume: str) -> float | None:
    text = resume.lower()
    lines = text.splitlines()
    section_heading = re.compile(r"^\s*(?:professional\s+|work\s+)?experience\s*$", re.I)
    other_heading = re.compile(
        r"^\s*(?:education|projects?|technical skills|skills|certifications?|achievements?|"
        r"publications?|summary|profile|volunteer experience)\s*$", re.I
    )
    section_start = next((i for i, line in enumerate(lines) if section_heading.match(line)), None)
    if section_start is not None:
        section_end = next((i for i in range(section_start + 1, len(lines)) if other_heading.match(lines[i])), len(lines))
        experience_text = "\n".join(lines[section_start + 1:section_end])
    else:
        experience_text = text

    explicit = [float(match.group(1)) for match in re.finditer(
        r"\b(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:(?:professional|work|industry)\s+)?experience\b", experience_text
    )]
    if explicit:
        return max(explicit)

    month = r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
    date_range = re.compile(rf"\b(?:(?P<start_month>{month})\s+)?(?P<start_year>(?:19|20)\d{{2}})\s*(?:-|–|—|to)\s*(?:(?P<end_month>{month})\s+)?(?P<end_year>(?:19|20)\d{{2}}|present|current)\b", re.I)

    def date_number(month_name: str | None, year: str, end: bool = False) -> int:
        if month_name:
            key = month_name[:3].title()
            month_number = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].index(key)
        else:
            month_number = 11 if end else 0
        year_number = datetime.now().year if year in {"present", "current"} else int(year)
        return year_number * 12 + month_number + (1 if end else 0)

    periods: list[tuple[int, int]] = []
    for match in date_range.finditer(experience_text):
        start = date_number(match.group("start_month"), match.group("start_year"))
        end = date_number(match.group("end_month"), match.group("end_year"), True)
        if start < end and end - start <= 600:
            periods.append((start, end))
    if not periods:
        return None
    periods.sort()
    total_months = 0
    start, end = periods[0]
    for next_start, next_end in periods[1:]:
        if next_start <= end:
            end = max(end, next_end)
        else:
            total_months += end - start
            start, end = next_start, next_end
    total_months += end - start
    return round(total_months / 6) / 2


class MatchRequest(BaseModel):
    resume: str
    job_description: str


def extract_resume_text(filename: str, contents: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in {".txt", ".md"}:
        return contents.decode("utf-8", errors="replace")
    if suffix == ".pdf":
        from pypdf import PdfReader
        return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(contents)).pages)
    if suffix == ".docx":
        from docx import Document
        return "\n".join(paragraph.text for paragraph in Document(io.BytesIO(contents)).paragraphs)
    raise HTTPException(415, "Use a PDF, DOCX, TXT, or MD resume.")


@app.get("/api/health")
def health():
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    configured = bool(api_key and api_key != "your-openai-api-key-here")
    return {"ok": True, "ai_enabled": configured}


@app.get("/api/resume")
def get_resume():
    files = [
        path for path in RESUME_DIR.iterdir()
        if path.is_file()
        and not path.name.startswith(".")
        and path.name.lower() != "readme.md"
        and path.suffix.lower() in SUPPORTED_RESUME_TYPES
    ] if RESUME_DIR.exists() else []
    if not files:
        raise HTTPException(404, "No resume found. Put your current PDF, DOCX, TXT, or MD file in the JobFit_Edge/Resume folder.")
    if len(files) > 1:
        raise HTTPException(409, "Keep only one resume file in the Resume folder.")
    path = files[0]
    try:
        text = extract_resume_text(path.name, path.read_bytes())
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Could not read {path.name}: {exc}") from exc
    if not text.strip():
        raise HTTPException(422, "No selectable text found in the resume. For scanned PDFs, use a text-based PDF or paste its text into a .txt file.")
    return {"filename": path.name, "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"), "text": text[:50000]}


@app.post("/api/match")
async def match(request: MatchRequest):
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key or api_key == "your-openai-api-key-here":
        raise HTTPException(503, "OPENAI_API_KEY is not configured.")
    try:
        resume_text = request.resume[:50000].strip()
        job_description = request.job_description[:24000].strip()
        if not resume_text or not job_description:
            raise HTTPException(422, "Resume and job description must both contain text.")

        # RAG over the resume: chunk and embed it, then retrieve only passages
        # relevant to this specific job before asking the chat model to score.
        resume_chunks = RESUME_SPLITTER.create_documents([resume_text])
        embeddings = OpenAIEmbeddings(
            model=os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
            api_key=api_key,
        )
        resume_index = FAISS.from_documents(resume_chunks, embeddings)
        retrieved = resume_index.similarity_search(job_description[:8000], k=min(6, len(resume_chunks)))
        resume_context = "\n\n---\n\n".join(doc.page_content for doc in retrieved)

        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-6-luna"),
            api_key=api_key,
            reasoning_effort=os.getenv("OPENAI_REASONING_EFFORT", "medium"),
        ).with_structured_output(SkillMatch)
        data = llm.invoke(MATCH_PROMPT.invoke({
            "minimum_years": f"{extract_minimum_years(job_description)} years" if extract_minimum_years(job_description) is not None else "not detected",
            "candidate_years": f"{extract_candidate_years(resume_text)} years" if extract_candidate_years(resume_text) is not None else "not detected",
            "resume_context": resume_context,
            "job_description": job_description,
        }))
        skill_score = max(0, min(100, int(data.skill_score)))
        experience_score = None
        overall_score = skill_score
        required_years = extract_minimum_years(job_description)
        candidate_years = extract_candidate_years(resume_text)
        if required_years is not None:
            experience_score = 100 if required_years <= 0 else (0 if candidate_years is None else max(0, min(100, round(candidate_years / required_years * 100))))
            overall_score = round(skill_score * 0.4 + experience_score * 0.6)
        return {
            **data.model_dump(),
            "skill_score": skill_score,
            "minimum_years_required": required_years,
            "candidate_years_experience": candidate_years,
            "experience_score": experience_score,
            "overall_score": overall_score,
            "verdict": "Strong match" if overall_score >= 75 else "Possible match" if overall_score >= 50 else "Low match",
            "ai_enabled": True,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"LangChain/OpenAI analysis failed: {exc}") from exc
