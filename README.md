# JobFit Edge extension

JobFit compares one saved resume with a job description. It can scan the active job page (including common LinkedIn, Indeed, and Naukri layouts), or you can paste the description yourself. YOE is detected automatically from the resume's Experience section and the job description; the fields are display-only. The local FastAPI helper uses LangChain and LangChain's OpenAI integrations: it splits the resume into overlapping chunks, embeds and indexes those chunks with FAISS, retrieves passages relevant to the job description, and asks a structured-output chat model for the skill match and concise summary. YOE is weighted at 60% of the overall score when a minimum is specified. The built-in local matcher is used only when the API key is missing or the API request fails. Match results are saved in extension storage and restored when the popup is reopened.

## Install in Microsoft Edge

1. Open `edge://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `extension` folder.
3. Put exactly one current resume file (PDF, DOCX, TXT, or MD) in the `Resume` folder beside this README.
4. Start the local helper below, then open a job posting and click the JobFit toolbar icon. Choose **Scan this page** or paste a description.
5. Click **Check my fit**. JobFit reads the saved resume automatically; replace the file in `Resume` when your resume changes.

Page scanning depends on the content currently loaded. If a portal blocks extension access or its page layout changes, copy the job description into the field. The scanner uses visible page text as a fallback, so review and trim the extracted text before matching.

## Start or restart the local helper

The extension needs the helper to load the resume from the `Resume` folder. From this project folder, start or restart it with one command:

```sh
./start.sh
```

The script creates `.venv` and installs requirements on first run, then starts the helper in the background. Running it again restarts the server listening on port 8766. Logs are written to `.run/server.log`. Set `OPENAI_API_KEY` in `.env` (replace the placeholder) to use OpenAI; if the key is absent or an API request fails, JobFit shows a local estimate.

The helper listens only on your machine. Your OpenAI key stays in the local Python process and is never stored in the extension. The resume chunks and FAISS index are created for each match request and are not persisted. Set `OPENAI_MODEL` to choose the chat model (default `gpt-6-luna`), `OPENAI_REASONING_EFFORT` to choose reasoning effort (default `medium`), and `OPENAI_EMBEDDING_MODEL` to choose the embedding model (default `text-embedding-3-small`). The score is an estimate based on detected text and is not a hiring decision. Image-only/scanned PDF files may need OCR and are not supported by this simple extractor. Keep exactly one supported resume file in `Resume`; the helper reports an error if zero or multiple resumes are found.

## How the local estimate works

The fallback matcher looks for a built-in list of common skills in each text and reports overlap and missing listed skills. When a minimum YOE is supplied, both API and fallback scores combine YOE (60%) and skills (40%); without a minimum, the skill score is used alone. Any match score is an estimate, not a hiring decision.
