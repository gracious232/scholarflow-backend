# PaperSet — Backend (MVP)

This folder contains the Express backend for PaperSet with OpenAI integration, PDF export, and citation handling.

## Quick Start

```powershell
npm install
```

Create a `.env` file:
```
PORT=5000
OPENAI_API_KEY=sk-your_key_here
NODE_ENV=development
```

Then run:
```powershell
npm run start
```

Or for development with auto-reload:
```powershell
npm install -g nodemon
npm run dev
```

## Features Implemented

✅ **Smart Transform** — OpenAI-powered text restructuring  
✅ **Citation Extraction** — Regex-based citation detection  
✅ **PDF Export** — Puppeteer-powered PDF generation  
✅ **Text Export** — DOCX/text file export (stub)  
✅ **Citation Styles** — APA, MLA, Chicago (basic format)  

## API Endpoints

- `POST /api/transform` — Transform messy text to academic paper
- `POST /api/export/pdf` — Export HTML to PDF
- `POST /api/export/docx` — Export to text file (DOCX stub)
- `GET /api/templates` — Available citation styles
- `GET /health` — Health check

## Dependencies

- **express** — Web framework
- **openai** — OpenAI API client
- **puppeteer** — PDF generation
- **citation-js** — Citation handling (included for future use)
- **cors** — Cross-Origin Resource Sharing
- **body-parser** — JSON parsing
- **dotenv** — Environment variables
