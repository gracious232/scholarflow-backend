require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const puppeteer = require('puppeteer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { Document, Packer, Paragraph, HeadingLevel, AlignmentType, PageBreak, TextRun, SectionProperties, PageMargin, convertInchesToTwip, Header, Footer, PageNumber } = require('docx');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// File upload setup
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Initialize SQLite database. Use DB_PATH in production (for example Render disk mount).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'papers.db');
const db = new sqlite3.Database(DB_PATH);

// Create tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      content TEXT,
      formatted_content TEXT,
      html TEXT,
      citations TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS formatting_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      template_name TEXT NOT NULL,
      professor_name TEXT,
      course_name TEXT,
      style TEXT,
      title_page BOOLEAN,
      font TEXT,
      font_size INTEGER,
      line_spacing TEXT,
      margins TEXT,
      page_numbers TEXT,
      running_head BOOLEAN,
      reference_title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS draft_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      assignment_name TEXT NOT NULL,
      paper_title TEXT,
      content TEXT,
      word_count INTEGER DEFAULT 0,
      metrics_json TEXT,
      formatting_json TEXT,
      professor_mode_json TEXT,
      change_summary_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_draft_snapshots_user_assignment
    ON draft_snapshots(user_id, assignment_name, created_at)
  `);
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-demo-key'
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ========== FILE PARSING FUNCTIONS ==========

// Parse DOCX file
async function parseDOCX(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (err) {
    throw new Error('Failed to parse DOCX: ' + err.message);
  }
}

// Parse PDF file
async function parsePDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    throw new Error('Failed to parse PDF: ' + err.message);
  }
}

function normalizeWordList(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function countWords(text) {
  return normalizeWordList(text).length;
}

function sentenceCount(text) {
  const matches = (text || '').match(/[^.!?]+[.!?]+/g);
  if (!matches) return (text || '').trim() ? 1 : 0;
  return matches.length;
}

function detectParagraphCount(text) {
  return (text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean).length;
}

function estimateIssues(text) {
  const source = (text || '').toString();
  const repeatedSpace = (source.match(/\s{2,}/g) || []).length;
  const repeatedPunctuation = (source.match(/[!?.,]{2,}/g) || []).length;
  const lowercaseSentenceStart = (source.match(/(?:^|[.!?]\s+)[a-z]/g) || []).length;
  const veryLongSentence = (source.match(/[^.!?]{220,}[.!?]/g) || []).length;
  const trailingWhitespace = (source.match(/[ \t]+$/gm) || []).length;
  const tabIndentation = (source.match(/^\t+/gm) || []).length;

  return {
    grammar: lowercaseSentenceStart + repeatedPunctuation,
    spelling: repeatedPunctuation,
    formatting: repeatedSpace + trailingWhitespace,
    major_formatting: tabIndentation,
    clarity: veryLongSentence
  };
}

function detectMissingCoreSections(text) {
  const source = (text || '').toLowerCase();
  const hasIntroduction = /\bintroduction\b/.test(source);
  const hasConclusion = /\bconclusion\b/.test(source);
  const hasReferences = /\breferences\b|\bworks cited\b|\bbibliography\b/.test(source);

  const missing = [];
  if (!hasIntroduction) missing.push('introduction');
  if (!hasConclusion) missing.push('conclusion');
  if (!hasReferences) missing.push('references');

  return missing;
}

function countTransitionMarkers(text) {
  const source = (text || '').toLowerCase();
  const markers = [
    'however', 'therefore', 'moreover', 'furthermore', 'in addition',
    'for example', 'for instance', 'as a result', 'in conclusion', 'first', 'second'
  ];

  return markers.reduce((count, marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = source.match(new RegExp(`\\b${escaped}\\b`, 'g'));
    return count + (matches ? matches.length : 0);
  }, 0);
}

function countDevelopmentSignals(text) {
  const source = (text || '').toLowerCase();
  const signals = [
    'because', 'for example', 'for instance', 'this shows', 'this demonstrates',
    'such as', 'for this reason', 'evidence', 'analysis'
  ];

  return signals.reduce((count, signal) => {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = source.match(new RegExp(`\\b${escaped}\\b`, 'g'));
    return count + (matches ? matches.length : 0);
  }, 0);
}

function detectSimpleHeaderLines(text) {
  const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const topLines = lines.slice(0, 8).join(' ').toLowerCase();
  const tokens = ['professor', 'course', 'student', 'name', 'date'];
  return tokens.some((token) => topLines.includes(token));
}

function calculateGrammarPenalty(grammarIssues) {
  if (grammarIssues <= 0) return 0;
  if (grammarIssues <= 5) return 2;
  if (grammarIssues <= 15) return 5;
  if (grammarIssues <= 25) return 8;
  return 12;
}

function clampScore(value, min = 0, max = 25) {
  return Math.max(min, Math.min(max, value));
}

function calculateDraftScore(metrics, text, formattingSettings = {}) {
  const missingSections = metrics.missing_sections || [];
  const transitions = countTransitionMarkers(text);
  const developmentSignals = countDevelopmentSignals(text);
  const hasIntro = !missingSections.includes('introduction');
  const hasConclusion = !missingSections.includes('conclusion');
  const hasReferences = !missingSections.includes('references') || (metrics.citation_count || 0) > 0;

  const words = metrics.word_count || 0;
  const paragraphs = metrics.paragraph_count || 0;
  const avgSentenceLen = metrics.average_sentence_length || 0;
  const lexicalDensity = words > 0 ? (new Set(normalizeWordList(text)).size / words) : 0;

  let contentIdeas = 14;
  if (words >= 220) contentIdeas += 3;
  if (words >= 450) contentIdeas += 2;
  if (paragraphs >= 3) contentIdeas += 2;
  if (developmentSignals >= 2) contentIdeas += 2;
  if (developmentSignals >= 5) contentIdeas += 1;
  if (lexicalDensity >= 0.42) contentIdeas += 1;
  if (hasIntro) contentIdeas += 1;
  if (hasConclusion) contentIdeas += 1;
  if (words < 120) contentIdeas -= 6;
  if (paragraphs <= 1) contentIdeas -= 4;
  contentIdeas = clampScore(Math.round(contentIdeas), 8, 25);

  let organization = 13;
  if (hasIntro) organization += 4;
  if (hasConclusion) organization += 4;
  if (paragraphs >= 3) organization += 3;
  if (transitions >= 3) organization += 1;
  if (transitions >= 6) organization += 1;
  if (avgSentenceLen > 34) organization -= 2;
  if (avgSentenceLen < 7 && words > 80) organization -= 2;
  if (paragraphs <= 1) organization -= 5;
  organization = clampScore(Math.round(organization), 6, 25);

  const grammarPenalty = calculateGrammarPenalty(metrics.grammar_issues || 0);
  const spellingPenalty = Math.min((metrics.spelling_issues || 0) * 0.6, 6);
  const clarityPenalty = Math.min((metrics.clarity_flags || 0) * 0.5, 3);
  const grammarMechanics = clampScore(Math.round(25 - grammarPenalty - spellingPenalty - clarityPenalty), 8, 25);

  const firstLine = ((text || '').split('\n').find((line) => line.trim()) || '').trim();
  const hasLikelyTitle = firstLine.length >= 8 && firstLine.length <= 140 && !/[.!?]$/.test(firstLine);
  const hasHeaderInfo = detectSimpleHeaderLines(text);
  const hasParagraphSpacing = paragraphs >= 3;
  const formattingMatched = !!formattingSettings.font && !!formattingSettings.line_spacing;
  const formattingPenalty = Math.min((metrics.minor_formatting_issues || 0) * 0.4 + (metrics.major_formatting_issues || 0) * 1.5, 6);

  let formattingReferences = 14;
  if (hasLikelyTitle) formattingReferences += 4;
  if (hasHeaderInfo) formattingReferences += 2;
  if (hasParagraphSpacing) formattingReferences += 2;
  if (hasReferences) formattingReferences += 2;
  if (formattingMatched) formattingReferences += 1;
  formattingReferences -= formattingPenalty;
  formattingReferences = clampScore(Math.round(formattingReferences), 8, 25);

  const total = Math.round(contentIdeas + organization + grammarMechanics + formattingReferences);

  return {
    score: clampScore(total, 0, 100),
    breakdown: {
      content_ideas: { score: contentIdeas, out_of: 25 },
      organization_structure: { score: organization, out_of: 25 },
      grammar_mechanics: { score: grammarMechanics, out_of: 25 },
      formatting_references: { score: formattingReferences, out_of: 25 },
      total: clampScore(total, 0, 100)
    }
  };
}

function buildDraftMetrics(text, citations, formattingSettings = {}) {
  const words = countWords(text);
  const sentences = sentenceCount(text);
  const paragraphs = detectParagraphCount(text);
  const issues = estimateIssues(text);
  const averageSentenceLength = sentences > 0 ? words / sentences : words;
  const clarityScore = Math.max(0, Math.min(100, Math.round(100 - (averageSentenceLength - 18) * 2 - issues.clarity * 6)));
  const missingSections = detectMissingCoreSections(text);

  const baseMetrics = {
    word_count: words,
    sentence_count: sentences,
    paragraph_count: paragraphs,
    citation_count: Array.isArray(citations) ? citations.length : 0,
    average_sentence_length: Number(averageSentenceLength.toFixed(2)),
    grammar_issues: issues.grammar,
    spelling_issues: issues.spelling,
    formatting_issues: issues.formatting + issues.major_formatting,
    minor_formatting_issues: issues.formatting,
    major_formatting_issues: issues.major_formatting,
    clarity_flags: issues.clarity,
    clarity_score: clarityScore,
    missing_sections: missingSections
  };

  const scoring = calculateDraftScore(baseMetrics, text, formattingSettings);

  return {
    ...baseMetrics,
    draft_score: scoring.score,
    score_breakdown: scoring.breakdown
  };
}

function parseRequiredSections(rawRequiredSections) {
  if (Array.isArray(rawRequiredSections)) {
    return rawRequiredSections.map((s) => (s || '').toString().trim()).filter(Boolean);
  }

  if (typeof rawRequiredSections === 'string') {
    return rawRequiredSections.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return [];
}

function detectMissingSections(content, requiredSections) {
  const source = (content || '').toLowerCase();
  return requiredSections.filter((section) => !source.includes(section.toLowerCase()));
}

function inferRubricRisks(rubricText, checkResult) {
  const lines = (rubricText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const risks = [];
  let atRisk = 0;

  lines.forEach((line) => {
    const pointsMatch = line.match(/(\d+)\s*points?/i);
    const points = pointsMatch ? parseInt(pointsMatch[1], 10) : 5;
    const lower = line.toLowerCase();
    let triggered = false;

    if (lower.includes('title') && checkResult.deviations.some((d) => d.requirement === 'title_page')) {
      triggered = true;
    }
    if (lower.includes('spacing') && checkResult.deviations.some((d) => d.requirement === 'line_spacing')) {
      triggered = true;
    }
    if ((lower.includes('citation') || lower.includes('reference')) && checkResult.deviations.some((d) => d.requirement === 'citation_style')) {
      triggered = true;
    }
    if (lower.includes('word') && checkResult.deviations.some((d) => d.requirement === 'word_count')) {
      triggered = true;
    }
    if (lower.includes('section') && checkResult.deviations.some((d) => d.requirement === 'required_sections')) {
      triggered = true;
    }

    if (triggered) {
      atRisk += points;
      risks.push({ rubric_line: line, points_at_risk: points });
    }
  });

  return {
    points_at_risk: atRisk,
    flagged_items: risks
  };
}

function evaluateProfessorMode(payload) {
  const {
    paper_content,
    formatting_settings = {},
    professor_mode = {},
    paper_info = {}
  } = payload || {};

  const requiredSections = parseRequiredSections(professor_mode.required_sections);
  const minWords = parseInt(professor_mode.min_word_count || 0, 10) || 0;
  const maxWords = parseInt(professor_mode.max_word_count || 0, 10) || 0;
  const expectedStyle = professor_mode.citation_style || formatting_settings.style || 'APA 7';
  const expectedFont = professor_mode.font || formatting_settings.font || 'Times New Roman';
  const expectedSpacing = professor_mode.line_spacing || formatting_settings.line_spacing || 'Double';
  const expectedMargins = professor_mode.margins || formatting_settings.margins || '1 inch';
  const expectedTitlePage = typeof professor_mode.title_page === 'boolean' ? professor_mode.title_page : true;

  const metrics = buildDraftMetrics(paper_content, extractCitations(paper_content));
  const missingSections = detectMissingSections(paper_content, requiredSections);
  const deviations = [];

  if ((formatting_settings.style || '').toLowerCase() !== expectedStyle.toLowerCase()) {
    deviations.push({ requirement: 'citation_style', expected: expectedStyle, actual: formatting_settings.style || 'Not set' });
  }
  if ((formatting_settings.font || '').toLowerCase() !== expectedFont.toLowerCase()) {
    deviations.push({ requirement: 'font', expected: expectedFont, actual: formatting_settings.font || 'Not set' });
  }
  if ((formatting_settings.line_spacing || '').toLowerCase() !== expectedSpacing.toLowerCase()) {
    deviations.push({ requirement: 'line_spacing', expected: expectedSpacing, actual: formatting_settings.line_spacing || 'Not set' });
  }
  if ((formatting_settings.margins || '').toLowerCase() !== expectedMargins.toLowerCase()) {
    deviations.push({ requirement: 'margins', expected: expectedMargins, actual: formatting_settings.margins || 'Not set' });
  }
  if (!!formatting_settings.title_page !== !!expectedTitlePage) {
    deviations.push({ requirement: 'title_page', expected: expectedTitlePage ? 'Required' : 'Not required', actual: formatting_settings.title_page ? 'Enabled' : 'Disabled' });
  }
  if (minWords && metrics.word_count < minWords) {
    deviations.push({ requirement: 'word_count', expected: `>= ${minWords}`, actual: metrics.word_count });
  }
  if (maxWords && metrics.word_count > maxWords) {
    deviations.push({ requirement: 'word_count', expected: `<= ${maxWords}`, actual: metrics.word_count });
  }
  if (missingSections.length > 0) {
    deviations.push({ requirement: 'required_sections', expected: requiredSections.join(', '), actual: `Missing: ${missingSections.join(', ')}` });
  }
  if (!paper_info?.paper_title || !paper_info.paper_title.trim()) {
    deviations.push({ requirement: 'assignment_title', expected: 'Title present', actual: 'Missing title' });
  }

  const rubricRisk = inferRubricRisks(professor_mode.rubric_text || professor_mode.template_text || '', { deviations });

  return {
    assignment_name: professor_mode.assignment_name || 'General Assignment',
    expected: {
      citation_style: expectedStyle,
      font: expectedFont,
      line_spacing: expectedSpacing,
      margins: expectedMargins,
      title_page: expectedTitlePage,
      required_sections: requiredSections,
      min_word_count: minWords,
      max_word_count: maxWords
    },
    actual: {
      citation_style: formatting_settings.style,
      font: formatting_settings.font,
      line_spacing: formatting_settings.line_spacing,
      margins: formatting_settings.margins,
      title_page: formatting_settings.title_page,
      word_count: metrics.word_count,
      missing_sections: missingSections
    },
    deviations,
    metrics,
    rubric_risk: rubricRisk
  };
}

function normalizeTextBlock(text) {
  return (text || '').replace(/\r\n/g, '\n').trim();
}

function findLabeledSections(text) {
  const normalized = normalizeTextBlock(text);
  const lines = normalized.split('\n');
  const sectionAliases = {
    assignment_instructions: ['assignment instructions'],
    professor_instructions: ['professor instructions'],
    task: ['task'],
    requirements: ['requirements'],
    rubric: ['rubric']
  };

  const headings = [];
  lines.forEach((line, idx) => {
    const clean = line.trim().toLowerCase().replace(/[:\-]+$/, '');
    Object.entries(sectionAliases).forEach(([key, aliases]) => {
      if (aliases.includes(clean)) {
        headings.push({ key, lineIndex: idx, title: line.trim() });
      }
    });
  });

  if (headings.length === 0) {
    return {};
  }

  const sections = {};
  headings.forEach((heading, i) => {
    const start = heading.lineIndex + 1;
    const end = i + 1 < headings.length ? headings[i + 1].lineIndex : lines.length;
    sections[heading.key] = lines.slice(start, end).join('\n').trim();
  });

  return sections;
}

function extractWordCountRange(text) {
  const source = normalizeTextBlock(text);
  const rangeMatch = source.match(/(\d{2,5})\s*(?:-|to)\s*(\d{2,5})\s*words?/i);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1], 10),
      max: parseInt(rangeMatch[2], 10),
      raw: rangeMatch[0]
    };
  }

  const minMatch = source.match(/(?:minimum|min\.?)\s*(?:of\s*)?(\d{2,5})\s*words?/i);
  const maxMatch = source.match(/(?:maximum|max\.?)\s*(?:of\s*)?(\d{2,5})\s*words?/i);
  if (minMatch || maxMatch) {
    return {
      min: minMatch ? parseInt(minMatch[1], 10) : null,
      max: maxMatch ? parseInt(maxMatch[1], 10) : null,
      raw: [minMatch?.[0], maxMatch?.[0]].filter(Boolean).join(' / ')
    };
  }

  return null;
}

function extractRequiredSections(text) {
  const source = normalizeTextBlock(text).toLowerCase();
  const sectionKeywords = ['introduction', 'body', 'main body', 'conclusion', 'abstract', 'references', 'works cited', 'bibliography'];
  const found = [];

  sectionKeywords.forEach((keyword) => {
    if (source.includes(keyword)) found.push(keyword);
  });

  // Normalize synonyms so UI stays consistent.
  const normalized = new Set();
  found.forEach((item) => {
    if (item === 'main body') normalized.add('body');
    else if (item === 'works cited' || item === 'bibliography') normalized.add('references');
    else normalized.add(item);
  });

  return Array.from(normalized);
}

function extractCitationRequirements(text) {
  const source = normalizeTextBlock(text);
  const styleMatches = source.match(/(APA\s*\d*|MLA|Chicago|Harvard|IEEE)/gi) || [];
  const mentionCitations = /citation|reference|works cited|bibliography/i.test(source);
  return {
    styles: Array.from(new Set(styleMatches.map((s) => s.toUpperCase().replace(/\s+/g, ' ').trim()))),
    references_required: mentionCitations
  };
}

function extractFormattingRules(text) {
  const source = normalizeTextBlock(text);
  const fontMatch = source.match(/(?:font|typeface)\s*[:\-]?\s*(Times New Roman|Arial|Calibri|Georgia)/i);
  const spacingMatch = source.match(/(?:double|single|1\.5)\s*(?:line\s*)?spacing/i);
  const marginMatch = source.match(/(0\.5|0\.75|1|1\.25|1\.5)\s*inch\s*margins?/i);

  return {
    font: fontMatch ? fontMatch[1] : null,
    line_spacing: spacingMatch ? spacingMatch[0].replace(/\s+/g, ' ').trim() : null,
    margins: marginMatch ? `${marginMatch[1]} inch` : null
  };
}

function extractRequiredSources(text) {
  const source = normalizeTextBlock(text);
  const countMatch = source.match(/(?:at least|minimum of|use)\s*(\d{1,2})\s*(?:credible\s*)?(?:sources|references)/i);
  if (!countMatch) {
    return {
      minimum_sources: null,
      raw: null
    };
  }

  return {
    minimum_sources: parseInt(countMatch[1], 10),
    raw: countMatch[0]
  };
}

function extractDueDate(text) {
  const source = normalizeTextBlock(text);
  const dueMatch = source.match(/(?:due\s*(?:date)?\s*[:\-]?\s*)([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  return dueMatch ? dueMatch[1].trim() : null;
}

function buildAssignmentChecklist(extracted) {
  const checklist = [];

  if (extracted.word_count) {
    const rangeLabel = extracted.word_count.min && extracted.word_count.max
      ? `${extracted.word_count.min}-${extracted.word_count.max} words`
      : extracted.word_count.min
      ? `Minimum ${extracted.word_count.min} words`
      : `Maximum ${extracted.word_count.max} words`;
    checklist.push({ id: 'word_count', label: `Meet word count: ${rangeLabel}`, category: 'requirements' });
  }

  if ((extracted.required_sections || []).length > 0) {
    checklist.push({
      id: 'required_sections',
      label: `Include required sections: ${(extracted.required_sections || []).join(', ')}`,
      category: 'requirements'
    });
  }

  if ((extracted.citation?.styles || []).length > 0 || extracted.citation?.references_required) {
    const citationLabel = (extracted.citation.styles || []).length > 0
      ? `Use citation style: ${extracted.citation.styles.join(', ')}`
      : 'Include citations and references section';
    checklist.push({ id: 'citation_style', label: citationLabel, category: 'citations' });
  }

  if (extracted.formatting?.font || extracted.formatting?.line_spacing || extracted.formatting?.margins) {
    const parts = [];
    if (extracted.formatting.font) parts.push(`Font: ${extracted.formatting.font}`);
    if (extracted.formatting.line_spacing) parts.push(`Spacing: ${extracted.formatting.line_spacing}`);
    if (extracted.formatting.margins) parts.push(`Margins: ${extracted.formatting.margins}`);
    checklist.push({ id: 'formatting', label: `Apply formatting rules (${parts.join('; ')})`, category: 'formatting' });
  }

  if (extracted.required_sources?.minimum_sources) {
    checklist.push({
      id: 'required_sources',
      label: `Use at least ${extracted.required_sources.minimum_sources} sources`,
      category: 'sources'
    });
  }

  if (extracted.due_date) {
    checklist.push({ id: 'due_date', label: `Submit by: ${extracted.due_date}`, category: 'deadline' });
  }

  return checklist;
}

function extractAssignmentRequirements(text) {
  const normalized = normalizeTextBlock(text);
  const sections = findLabeledSections(normalized);
  const sourceForRequirements = Object.values(sections).join('\n\n') || normalized;

  const extracted = {
    word_count: extractWordCountRange(sourceForRequirements),
    required_sections: extractRequiredSections(sourceForRequirements),
    citation: extractCitationRequirements(sourceForRequirements),
    formatting: extractFormattingRules(sourceForRequirements),
    required_sources: extractRequiredSources(sourceForRequirements),
    due_date: extractDueDate(sourceForRequirements)
  };

  return {
    detected_sections: Object.keys(sections),
    sections,
    extracted,
    checklist: buildAssignmentChecklist(extracted)
  };
}

// ========== CITATION PARSING & FORMATTING ==========

// Helper: extract citations from text
function extractCitations(text) {
  const citations = [];
  const citationPattern = /\[([^,\]]+),\s*(\d{4})\]|\(([^,\)]+),\s*(\d{4})\)/g;
  let match;
  
  while ((match = citationPattern.exec(text)) !== null) {
    const author = match[1] || match[3];
    const year = match[2] || match[4];
    
    citations.push({
      author: author.trim(),
      year: parseInt(year),
      raw: match[0]
    });
  }
  
  return citations;
}

function formatCitation(citation, style) {
  const { author, year } = citation;
  
  switch (style.toUpperCase()) {
    case 'APA 7':
    case 'APA':
      return `(${author}, ${year})`;
    case 'MLA':
      return `(${author} ${year})`;
    case 'CHICAGO':
      return `(${author} ${year})`;
    default:
      return `(${author}, ${year})`;
  }
}

function formatReferenceEntry(citation, style) {
  const { author, year } = citation;
  
  switch (style.toUpperCase()) {
    case 'APA 7':
    case 'APA':
      return `${author} (${year}). [Title]. [Journal/Publisher].`;
    case 'MLA':
      return `${author}. "[Title]." [Journal/Publisher], ${year}.`;
    case 'CHICAGO':
      return `${author}. "[Title]." [Journal/Publisher] (${year}).`;
    default:
      return `${author} (${year}). [Citation details]`;
  }
}

function getStyleKey(style) {
  const value = (style || 'APA').toString().trim().toUpperCase();
  if (value.includes('MLA')) return 'MLA';
  if (value.includes('CHICAGO')) return 'CHICAGO';
  return 'APA';
}

function getReferenceSectionTitle(formatting, style) {
  if (formatting?.reference_title && formatting.reference_title.trim()) {
    return formatting.reference_title.trim();
  }

  const styleKey = getStyleKey(style);
  if (styleKey === 'MLA') return 'Works Cited';
  if (styleKey === 'CHICAGO') return 'Bibliography';
  return 'References';
}

function citationKey(citation) {
  const author = (citation.author || '').trim().toLowerCase();
  const year = String(citation.year || '').trim();
  return `${author}|${year}`;
}

function dedupeCitations(citations) {
  const seen = new Set();
  const unique = [];

  (citations || []).forEach((citation) => {
    const key = citationKey(citation);
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(citation);
  });

  return unique;
}

function stripExistingReferenceSection(text) {
  if (!text) return text;

  const lines = text.split('\n');
  const refHeadingPattern = /^\s*(references|works cited|bibliography)\s*:?\s*$/i;
  const idx = lines.findIndex((line) => refHeadingPattern.test(line));

  if (idx === -1) return text;
  return lines.slice(0, idx).join('\n').trimEnd();
}

function enforceCitationStyleInText(text, style) {
  const citationPattern = /\[([^,\]]+),\s*(\d{4})\]|\(([^,\)]+),\s*(\d{4})\)/g;
  return (text || '').replace(citationPattern, (_, a1, y1, a2, y2) => {
    const citation = {
      author: (a1 || a2 || '').trim(),
      year: parseInt(y1 || y2, 10)
    };
    return formatCitation(citation, style);
  });
}

function buildCitationVerification(citations, referenceEntries) {
  const citedKeys = new Set((citations || []).map(citationKey));
  const referencedKeys = new Set((referenceEntries || []).map(citationKey));

  const missingInReferences = (citations || []).filter((c) => !referencedKeys.has(citationKey(c)));
  const uncitedReferences = (referenceEntries || []).filter((r) => !citedKeys.has(citationKey(r)));

  return {
    all_in_text_citations_in_references: missingInReferences.length === 0,
    all_references_are_cited: uncitedReferences.length === 0,
    missing_in_references: missingInReferences,
    uncited_references: uncitedReferences
  };
}

// Middleware: verify JWT token
function verifyToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ========== AUTH ENDPOINTS ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
      [email, hashedPassword, name || 'User'],
      function(err) {
        if (err) {
          return res.status(400).json({ error: 'Email already exists' });
        }
        
        const token = jwt.sign({ id: this.lastID }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, userId: this.lastID, email, name });
      }
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    try {
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, userId: user.id, email: user.email, name: user.name });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
});

// ========== FORMATTING TEMPLATES ==========

// GET all templates for user
app.get('/api/templates/my-templates', verifyToken, (req, res) => {
  db.all(
    'SELECT * FROM formatting_templates WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId],
    (err, templates) => {
      if (err) return res.status(500).json({ error: err.message });
      return res.json(templates || []);
    }
  );
});

// POST create template
app.post('/api/templates/create', verifyToken, (req, res) => {
  const {
    template_name, professor_name, course_name, style,
    title_page, font, font_size, line_spacing, margins,
    page_numbers, running_head, reference_title
  } = req.body;
  
  if (!template_name) return res.status(400).json({ error: 'Template name required' });
  
  db.run(
    `INSERT INTO formatting_templates 
    (user_id, template_name, professor_name, course_name, style, title_page, font, font_size, line_spacing, margins, page_numbers, running_head, reference_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.userId, template_name, professor_name, course_name, style, title_page ? 1 : 0, font, font_size, line_spacing, margins, page_numbers, running_head ? 1 : 0, reference_title],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ id: this.lastID, message: 'Template created' });
    }
  );
});

// DELETE template
app.delete('/api/templates/:id', verifyToken, (req, res) => {
  db.run(
    'DELETE FROM formatting_templates WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ message: 'Template deleted' });
    }
  );
});

// ========== FILE UPLOAD & PARSING ==========

// POST upload and parse file
app.post('/api/papers/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  try {
    let content = '';
    const fileType = req.file.originalname.split('.').pop().toLowerCase();
    
    if (fileType === 'docx') {
      content = await parseDOCX(req.file.buffer);
    } else if (fileType === 'pdf') {
      content = await parsePDF(req.file.buffer);
    } else if (fileType === 'txt') {
      content = req.file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use DOCX, PDF, or TXT.' });
    }
    
    return res.json({ content, fileName: req.file.originalname });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/professor-mode/upload-rubric', verifyToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No rubric file uploaded' });
  }

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    let content = '';

    if (ext === '.docx') {
      content = await parseDOCX(req.file.buffer);
    } else if (ext === '.pdf') {
      content = await parsePDF(req.file.buffer);
    } else if (ext === '.txt') {
      content = req.file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload DOCX, PDF, or TXT.' });
    }

    const extracted = extractAssignmentRequirements(content);

    return res.json({
      file_name: req.file.originalname,
      rubric_text: (content || '').trim(),
      detected_sections: extracted.detected_sections,
      extracted_requirements: extracted.extracted,
      checklist: extracted.checklist
    });
  } catch (error) {
    console.error('Rubric upload parse error:', error.message);
    return res.status(500).json({ error: `Failed to parse rubric: ${error.message}` });
  }
});

app.post('/api/professor-mode/extract-checklist', verifyToken, upload.single('file'), async (req, res) => {
  try {
    let text = '';
    let source = 'manual_input';

    if (req.file) {
      source = req.file.originalname;
      const ext = path.extname(req.file.originalname).toLowerCase();

      if (ext === '.docx') {
        text = await parseDOCX(req.file.buffer);
      } else if (ext === '.pdf') {
        text = await parsePDF(req.file.buffer);
      } else if (ext === '.txt') {
        text = req.file.buffer.toString('utf-8');
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Upload DOCX, PDF, or TXT.' });
      }
    } else if (req.body?.text) {
      text = req.body.text;
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No document text found for extraction.' });
    }

    const extracted = extractAssignmentRequirements(text);
    return res.json({
      source,
      detected_sections: extracted.detected_sections,
      sections: extracted.sections,
      extracted_requirements: extracted.extracted,
      checklist: extracted.checklist
    });
  } catch (error) {
    console.error('Checklist extraction error:', error.message);
    return res.status(500).json({ error: `Checklist extraction failed: ${error.message}` });
  }
});

app.post('/api/professor-mode/check', verifyToken, async (req, res) => {
  const { paper_content, formatting_settings, professor_mode } = req.body || {};

  if (!paper_content || !formatting_settings || !professor_mode) {
    return res.status(400).json({ error: 'Missing required fields: paper_content, formatting_settings, professor_mode' });
  }

  try {
    const result = evaluateProfessorMode(req.body);
    return res.json(result);
  } catch (error) {
    console.error('Professor mode check error:', error.message);
    return res.status(500).json({ error: `Professor check failed: ${error.message}` });
  }
});

app.post('/api/drafts/autosave', verifyToken, (req, res) => {
  const {
    assignment_name,
    paper_title,
    paper_content,
    formatting_settings = {},
    professor_mode = {},
    citations = []
  } = req.body || {};

  if (!assignment_name || !paper_content) {
    return res.status(400).json({ error: 'Missing required fields: assignment_name, paper_content' });
  }

  const metrics = buildDraftMetrics(paper_content, citations, formatting_settings);

  db.get(
    `SELECT id, content, metrics_json, created_at
     FROM draft_snapshots
     WHERE user_id = ? AND assignment_name = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [req.userId, assignment_name],
    (lookupErr, previousDraft) => {
      if (lookupErr) {
        return res.status(500).json({ error: lookupErr.message });
      }

      const previousMetrics = previousDraft?.metrics_json ? JSON.parse(previousDraft.metrics_json) : null;
      const previousText = previousDraft?.content || '';
      const currentWords = new Set(normalizeWordList(paper_content));
      const previousWords = new Set(normalizeWordList(previousText));
      let addedWords = 0;
      let removedWords = 0;

      currentWords.forEach((word) => {
        if (!previousWords.has(word)) addedWords += 1;
      });
      previousWords.forEach((word) => {
        if (!currentWords.has(word)) removedWords += 1;
      });

      const changeSummary = {
        word_count_delta: previousMetrics ? metrics.word_count - previousMetrics.word_count : metrics.word_count,
        grammar_delta: previousMetrics ? previousMetrics.grammar_issues - metrics.grammar_issues : 0,
        spelling_delta: previousMetrics ? previousMetrics.spelling_issues - metrics.spelling_issues : 0,
        formatting_delta: previousMetrics ? previousMetrics.formatting_issues - metrics.formatting_issues : 0,
        clarity_delta: previousMetrics ? metrics.clarity_score - previousMetrics.clarity_score : 0,
        citation_delta: previousMetrics ? metrics.citation_count - previousMetrics.citation_count : metrics.citation_count,
        vocabulary_added: addedWords,
        vocabulary_removed: removedWords
      };

      db.run(
        `INSERT INTO draft_snapshots (
          user_id, assignment_name, paper_title, content, word_count,
          metrics_json, formatting_json, professor_mode_json, change_summary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.userId,
          assignment_name,
          paper_title || 'Untitled Draft',
          paper_content,
          metrics.word_count,
          JSON.stringify(metrics),
          JSON.stringify(formatting_settings),
          JSON.stringify(professor_mode),
          JSON.stringify(changeSummary)
        ],
        function autosaveInsert(insertErr) {
          if (insertErr) {
            return res.status(500).json({ error: insertErr.message });
          }

          return res.json({
            snapshot_id: this.lastID,
            saved_at: new Date().toISOString(),
            metrics,
            change_summary: changeSummary
          });
        }
      );
    }
  );
});

app.get('/api/drafts/history', verifyToken, (req, res) => {
  const { assignment_name } = req.query;

  if (!assignment_name) {
    return res.status(400).json({ error: 'assignment_name query param is required' });
  }

  db.all(
    `SELECT id, paper_title, word_count, metrics_json, change_summary_json, created_at
     FROM draft_snapshots
     WHERE user_id = ? AND assignment_name = ?
     ORDER BY created_at DESC`,
    [req.userId, assignment_name],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const snapshots = (rows || []).map((row) => ({
        id: row.id,
        paper_title: row.paper_title,
        word_count: row.word_count,
        metrics: JSON.parse(row.metrics_json || '{}'),
        change_summary: JSON.parse(row.change_summary_json || '{}'),
        created_at: row.created_at
      }));

      const latest = snapshots[0];
      const oldest = snapshots[snapshots.length - 1];
      const improvement = latest && oldest
        ? {
            grammar_reduction: (oldest.metrics?.grammar_issues || 0) - (latest.metrics?.grammar_issues || 0),
            spelling_reduction: (oldest.metrics?.spelling_issues || 0) - (latest.metrics?.spelling_issues || 0),
            formatting_reduction: (oldest.metrics?.formatting_issues || 0) - (latest.metrics?.formatting_issues || 0),
            clarity_gain: (latest.metrics?.clarity_score || 0) - (oldest.metrics?.clarity_score || 0),
            word_growth: (latest.metrics?.word_count || 0) - (oldest.metrics?.word_count || 0)
          }
        : {
            grammar_reduction: 0,
            spelling_reduction: 0,
            formatting_reduction: 0,
            clarity_gain: 0,
            word_growth: 0
          };

      return res.json({
        assignment_name,
        total_drafts: snapshots.length,
        latest_metrics: latest?.metrics || null,
        improvement,
        snapshots
      });
    }
  );
});

app.get('/api/drafts/latest-score', verifyToken, (req, res) => {
  db.get(
    `SELECT assignment_name, paper_title, metrics_json, created_at
     FROM draft_snapshots
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [req.userId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!row) {
        return res.json({
          draft_score: null,
          assignment_name: null,
          paper_title: null,
          created_at: null
        });
      }

      const metrics = JSON.parse(row.metrics_json || '{}');
      return res.json({
        draft_score: metrics.draft_score ?? null,
        assignment_name: row.assignment_name || null,
        paper_title: row.paper_title || null,
        created_at: row.created_at || null,
        grammar_issues: metrics.grammar_issues ?? 0,
        spelling_issues: metrics.spelling_issues ?? 0
      });
    }
  );
});

// ========== ADVANCED FORMATTING ==========

function generateTitlePage(paperInfo, formatting) {
  const { paper_title, author_name, institution, professor_name, course_name, due_date } = paperInfo;
  
  return `
${paper_title || 'Untitled Paper'}

${author_name || '[Author Name]'}
${institution || '[Institution]'}
${professor_name ? 'Professor: ' + professor_name : ''}
${course_name ? 'Course: ' + course_name : ''}
${due_date ? 'Due Date: ' + due_date : ''}
${new Date().toLocaleDateString()}
`;
}

async function reformatDocument(text, paperInfo, formatting, style) {
  const citations = dedupeCitations(extractCitations(text));

  async function applyOptionalLanguageTools(content) {
    const shouldSimplify = !!formatting?.simplify_language;
    const shouldHumanize = !!formatting?.humanize_language;

    if (!shouldSimplify && !shouldHumanize) {
      return content;
    }

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-demo-key') {
      return content;
    }

    const selectedTools = [];
    if (shouldSimplify) selectedTools.push('Simplify Language');
    if (shouldHumanize) selectedTools.push('Humanize Language');

    const systemPrompt = `You are an academic writing assistant. Apply only the requested optional language tools while preserving the paper's structure, meaning, and citations.
- Do not remove sections, headings, references, or citations.
- Keep an academic tone appropriate for ${style} writing.
- Return only the revised full text.`;

    const userPrompt = `Requested tools: ${selectedTools.join(', ')}\n\nText:\n${content}`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 3000,
        temperature: 0.3
      });

      const revised = completion.choices?.[0]?.message?.content;
      return revised && revised.length > 50 ? revised : content;
    } catch (err) {
      console.log('Optional language tools failed, using original formatted content:', err.message);
      return content;
    }
  }
  
  // Build formatted document with title page if needed
  let finalDoc = '';
  
  if (formatting.title_page) {
    finalDoc += generateTitlePage(paperInfo, formatting);
    finalDoc += '\n\n' + '='.repeat(50) + '\n\n';
  }
  
  // Use AI to improve document structure if available and text is reasonable length
  if (text.length > 100 && text.length < 8000 && process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-demo-key') {
    const systemPrompt = `You are an expert academic formatter. Reformat this document following ${style} guidelines:
- Clear heading structure
- Proper paragraph formatting
- Academic language
- Logical flow

Return the full reformatted text, preserving ALL content.`;
    
    const userPrompt = `Please reformat this text in ${style} style, keeping all citations intact:\n\n${text}`;
    
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 3000,
        temperature: 0.3
      });
      
      const reformatted = completion.choices[0].message.content;
      
      const baseContent = reformatted && reformatted.length > 50 ? reformatted : text;
      finalDoc += await applyOptionalLanguageTools(baseContent);
    } catch (err) {
      // Fallback if API fails - use original text
      console.log('OpenAI API failed, using original text:', err.message);
      finalDoc += await applyOptionalLanguageTools(text);
    }
  } else {
    // Text too long or short for AI, or no API key - use original
    finalDoc += await applyOptionalLanguageTools(text);
  }
  
  // Remove any existing references block to avoid duplicate sections/pages.
  finalDoc = stripExistingReferenceSection(finalDoc);

  // Enforce a single in-text citation style based on selected format.
  finalDoc = enforceCitationStyleInText(finalDoc, style);

  // Add one references section in selected style.
  if (citations.length > 0) {
    finalDoc += '\n\n' + getReferenceSectionTitle(formatting, style) + '\n\n';
    citations.forEach(c => {
      finalDoc += formatReferenceEntry(c, style) + '\n';
    });
  }

  const verification = buildCitationVerification(citations, citations);
  return { formatted: finalDoc, citations, verification };
}

app.post('/api/papers/transform-with-formatting', verifyToken, async (req, res) => {
  const { paper_content, paper_info, formatting_settings } = req.body;
  
  if (!paper_content || !formatting_settings) {
    return res.status(400).json({ error: 'Missing required fields: paper_content, formatting_settings' });
  }
  
  console.log(`Transform request - content length: ${paper_content.length} chars`);
  console.log(`Optional language tools - simplify: ${!!formatting_settings?.simplify_language}, humanize: ${!!formatting_settings?.humanize_language}`);
  
  try {
    const { formatted, citations, verification } = await reformatDocument(
      paper_content,
      paper_info || {},
      formatting_settings,
      formatting_settings.style || 'APA'
    );
    
    console.log(`Transform complete - formatted length: ${formatted.length} chars, citations: ${citations.length}`);
    
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${paper_info?.paper_title || 'Paper'}</title>
  <style>
    body {
      font-family: ${formatting_settings.font || 'Times New Roman'};
      font-size: ${formatting_settings.font_size || 12}pt;
      line-height: ${formatting_settings.line_spacing === 'Double' ? 2 : formatting_settings.line_spacing === '1.5' ? 1.5 : 1};
      margin: ${formatting_settings.margins || '1'}in;
      white-space: pre-wrap;
    }
    h1 { text-align: center; margin-bottom: 30px; }
    h2 { margin-top: 25px; margin-bottom: 12px; }
    p { text-align: justify; margin-bottom: 12px; }
    .references { margin-top: 40px; page-break-before: always; }
  </style>
</head>
<body>${formatted.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</body>
</html>`;
    
    // Save to database
    db.run(
      'INSERT INTO papers (user_id, title, content, html, citations) VALUES (?, ?, ?, ?, ?)',
      [req.userId, paper_info?.paper_title || 'Untitled', formatted, html, JSON.stringify(citations)]
    );
    
    return res.json({
      formatted,
      html,
      citations,
      citation_verification: verification,
      formatting_applied: {
        style: formatting_settings.style,
        font: formatting_settings.font,
        font_size: formatting_settings.font_size,
        line_spacing: formatting_settings.line_spacing,
        title_page_added: formatting_settings.title_page,
        simplify_language: !!formatting_settings.simplify_language,
        humanize_language: !!formatting_settings.humanize_language
      }
    });
  } catch (error) {
    console.error('Transform error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: `Transform failed: ${error.message}` });
  }
});

// ========== PAPER TRANSFORMATION (Basic Transform) ==========

// POST /api/transform — Transform with auth
app.post('/api/transform', verifyToken, async (req, res) => {
  const { text, style = 'APA', title } = req.body || {};
  
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing `text` in request body' });
  }
  
  try {
    const citations = extractCitations(text);
    
    const systemPrompt = `You are an expert academic writing assistant. Transform the user's rough notes into a well-structured academic paper. 
    
    The output should include:
    1. A clear title
    2. An Introduction section
    3. A Main Body section (broken into subsections if relevant)
    4. A Conclusion section
    5. Any citations the user mentioned (maintain them in [Author, Year] format)
    
    Use clear academic language and proper transitions between sections.`;
    
    const userPrompt = `Please transform this rough draft into a structured academic paper:\n\n${text}`;
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 2000
    });
    
    const transformedText = completion.choices[0].message.content;
    
    // Parse sections
    const lines = transformedText.split('\n').filter(l => l.trim());
    let paperTitle = title || 'Untitled Paper';
    const sections = [];
    let currentSection = null;
    let content = [];
    
    for (const line of lines) {
      if (line.match(/^#+\s/) || line.match(/^[A-Z][^.!?]*$/)) {
        if (currentSection && content.length > 0) {
          sections.push({
            heading: currentSection,
            content: content.join('\n').trim()
          });
          content = [];
        }
        currentSection = line.replace(/^#+\s/, '').trim();
        if (!paperTitle || paperTitle === 'Untitled Paper') {
          paperTitle = currentSection;
        }
      } else if (line.trim()) {
        content.push(line);
      }
    }
    
    if (currentSection && content.length > 0) {
      sections.push({
        heading: currentSection,
        content: content.join('\n').trim()
      });
    }
    
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${paperTitle}</title>
  <style>
    body { font-family: 'Times New Roman', serif; line-height: 1.6; max-width: 850px; margin: 40px auto; padding: 20px; }
    h1 { text-align: center; margin-bottom: 30px; }
    h2 { margin-top: 25px; margin-bottom: 12px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
    p { text-align: justify; margin-bottom: 12px; }
    .references { margin-top: 40px; page-break-before: always; }
    .references h2 { border-bottom: none; }
    .reference-item { margin-left: 40px; text-indent: -40px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>${paperTitle}</h1>
  ${sections.map(s => `<h2>${s.heading}</h2><p>${s.content.replace(/\n/g, '</p><p>')}</p>`).join('')}
  ${citations.length > 0 ? `<div class="references"><h2>References</h2>${citations.map(c => `<div class="reference-item">${c.author} (${c.year}). [Add full citation details]</div>`).join('')}</div>` : ''}
</body>
</html>`;
    
    // Save to database
    db.run(
      'INSERT INTO papers (user_id, title, content, html, citations) VALUES (?, ?, ?, ?, ?)',
      [req.userId, paperTitle, transformedText, html, JSON.stringify(citations)]
    );
    
    return res.json({
      title: paperTitle,
      sections,
      citations,
      html,
      style
    });
  } catch (error) {
    console.error('Transform error:', error.message);
    return res.status(500).json({ error: `Transform failed: ${error.message}` });
  }
});

// ========== EXPORT ENDPOINTS ==========

function normalizePageNumberSetting(pageNumbers) {
  const value = (pageNumbers || 'Top Right').toString().trim();
  const allowed = new Set(['Top Right', 'Top Center', 'Bottom Right', 'Bottom Center', 'None']);
  return allowed.has(value) ? value : 'Top Right';
}

function getPdfPageNumberOptions(pageNumbers) {
  const setting = normalizePageNumberSetting(pageNumbers);

  if (setting === 'None') {
    return {
      displayHeaderFooter: false,
      headerTemplate: '<div></div>',
      footerTemplate: '<div></div>',
      isTop: false,
      isBottom: false
    };
  }

  const textAlign = setting.endsWith('Center') ? 'center' : 'right';
  const bar = `<div style="font-size:10px;color:#444;width:100%;padding:0 20px;text-align:${textAlign};"><span class="pageNumber"></span></div>`;

  return {
    displayHeaderFooter: true,
    headerTemplate: setting.startsWith('Top') ? bar : '<div></div>',
    footerTemplate: setting.startsWith('Bottom') ? bar : '<div></div>',
    isTop: setting.startsWith('Top'),
    isBottom: setting.startsWith('Bottom')
  };
}

function getDocxPageNumberConfig(pageNumbers, fontName, fontSize) {
  const setting = normalizePageNumberSetting(pageNumbers);

  if (setting === 'None') {
    return {};
  }

  const alignment = setting.endsWith('Center') ? AlignmentType.CENTER : AlignmentType.RIGHT;
  const runSize = Math.max((fontSize || 24) - 4, 16);

  const pageParagraph = new Paragraph({
    alignment,
    children: [
      new TextRun({ text: 'Page ', font: fontName, size: runSize }),
      PageNumber.CURRENT
    ]
  });

  if (setting.startsWith('Top')) {
    return {
      headers: {
        default: new Header({ children: [pageParagraph] })
      }
    };
  }

  return {
    footers: {
      default: new Footer({ children: [pageParagraph] })
    }
  };
}

// POST /api/export/pdf
app.post('/api/export/pdf', async (req, res) => {
  const { html } = req.body || {};
  
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing `html` in request body' });
  }
  
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      margin: { top: '40px', right: '40px', bottom: '40px', left: '40px' },
      printBackground: true,
      format: 'A4'
    });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="paper.pdf"');
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF export error:', error.message);
    console.error('Full error:', error);
    return res.status(500).json({ error: `PDF export failed: ${error.message}` });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// POST /api/export/pdf-formatted — Enhanced PDF with formatting
app.post('/api/export/pdf-formatted', async (req, res) => {
  const { html, formatting_settings } = req.body || {};
  
  if (!html) {
    return res.status(400).json({ error: 'Missing HTML content' });
  }
  
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    // Parse margin value - extract just the number
    const margins = formatting_settings?.margins || '1';
    const marginValue = parseFloat(margins.toString().replace(/[^0-9.]/g, '')) || 1;
    
    const pageNumberOptions = getPdfPageNumberOptions(formatting_settings?.page_numbers);
    const topMargin = pageNumberOptions.isTop ? Math.max(marginValue, 0.8) : marginValue;
    const bottomMargin = pageNumberOptions.isBottom ? Math.max(marginValue, 0.8) : marginValue;

    const pdfBuffer = await page.pdf({
      margin: { 
        top: `${topMargin}in`, 
        right: `${marginValue}in`, 
        bottom: `${bottomMargin}in`, 
        left: `${marginValue}in` 
      },
      displayHeaderFooter: pageNumberOptions.displayHeaderFooter,
      headerTemplate: pageNumberOptions.headerTemplate,
      footerTemplate: pageNumberOptions.footerTemplate,
      printBackground: true,
      format: 'A4'
    });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="formatted-paper.pdf"');
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF export error:', error.message);
    console.error('Full error:', error);
    return res.status(500).json({ error: `PDF export failed: ${error.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

// POST /api/export/docx — Full DOCX export using docx package
app.post('/api/export/docx', async (req, res) => {
  const { html, title } = req.body || {};
  
  if (!html) {
    return res.status(400).json({ error: 'Missing `html` in request body' });
  }
  
  try {
    // Parse HTML to extract text and structure
    const plainText = html.replace(/<[^>]*>/g, '').trim();
    const sections = [];
    
    // Extract sections from HTML (simple approach)
    const h2Pattern = /<h2>([^<]+)<\/h2>\s*<p>([\s\S]*?)<\/p>/g;
    let match;
    
    while ((match = h2Pattern.exec(html)) !== null) {
      sections.push({
        heading: match[1],
        content: match[2].replace(/<[^>]*>/g, '')
      });
    }
    
    // Create DOCX document with proper TextRun usage
    const children = [];
    
    // Add title
    children.push(
      new Paragraph({
        text: new TextRun({
          text: title || 'Untitled Paper',
          size: 28,
          bold: true
        }),
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 }
      })
    );
    
    // Add sections
    sections.forEach(section => {
      children.push(
        new Paragraph({
          text: new TextRun({
            text: section.heading,
            size: 24,
            bold: true
          }),
          spacing: { before: 200, after: 100 }
        })
      );
      
      children.push(
        new Paragraph({
          text: section.content,
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 200, line: 480, lineRule: 'auto' }
        })
      );
    });
    
    // Add references section
    children.push(new PageBreak());
    children.push(
      new Paragraph({
        text: new TextRun({
          text: 'References',
          size: 24,
          bold: true
        }),
        spacing: { before: 200, after: 100 }
      })
    );
    children.push(
      new Paragraph({
        text: '[References to be added from citation manager]',
        spacing: { after: 200 }
      })
    );
    
    const doc = new Document({ sections: [{ children }] });
    const docxBuffer = await Packer.toBuffer(doc);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${title || 'paper'}.docx"`);
    return res.send(docxBuffer);
  } catch (error) {
    console.error('DOCX export error:', error.message);
    return res.status(500).json({ error: `DOCX export failed: ${error.message}` });
  }
});

// POST /api/export/docx-formatted — Enhanced DOCX with full formatting
app.post('/api/export/docx-formatted', async (req, res) => {
  const { formatted_text, paper_title, formatting_settings, citations } = req.body;
  
  if (!formatted_text) {
    return res.status(400).json({ error: 'Missing formatted_text' });
  }
  
  try {
    const fontName = formatting_settings?.font || 'Times New Roman';
    const fontSize = (formatting_settings?.font_size || 12) * 2; // docx uses half-points
    const lineSpacing = formatting_settings?.line_spacing === 'Double' ? 480 : 
                        formatting_settings?.line_spacing === '1.5' ? 360 : 240;
    
    const children = [];
    
    // Split formatted text into lines and process
    const lines = formatted_text.split('\n');
    let currentParagraphLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Detect headings (lines that are ALL CAPS or contain multiple spaces at start indicating structure)
      const isHeading = line && (
        (line.toUpperCase() === line && line.length > 3 && !line.includes('(')) ||
        /^(Introduction|Conclusion|Methods|Results|Discussion|References|Reference|Abstract|Background|Literature|Review)$/i.test(line)
      );
      
      if (isHeading && line) {
        // Save any accumulated paragraph text first
        if (currentParagraphLines.length > 0) {
          const paragraphText = currentParagraphLines.join(' ').trim();
          if (paragraphText) {
            children.push(
              new Paragraph({
                children: [new TextRun({
                  text: paragraphText,
                  size: fontSize,
                  font: fontName
                })],
                alignment: AlignmentType.JUSTIFIED,
                spacing: { after: 200, line: lineSpacing, lineRule: 'auto' }
              })
            );
          }
          currentParagraphLines = [];
        }
        
        // Add heading
        children.push(
          new Paragraph({
            children: [new TextRun({
              text: line,
              size: fontSize + 4,
              bold: true,
              font: fontName
            })],
            spacing: { before: 240, after: 120, line: lineSpacing, lineRule: 'auto' }
          })
        );
      } else if (line === '' || line === '='.repeat(50)) {
        // Empty line or separator - flush paragraph
        if (currentParagraphLines.length > 0) {
          const paragraphText = currentParagraphLines.join(' ').trim();
          if (paragraphText) {
            children.push(
              new Paragraph({
                children: [new TextRun({
                  text: paragraphText,
                  size: fontSize,
                  font: fontName
                })],
                alignment: AlignmentType.JUSTIFIED,
                spacing: { after: 200, line: lineSpacing, lineRule: 'auto' }
              })
            );
          }
          currentParagraphLines = [];
        }
        // Add spacing between sections
        if (line === '') {
          children.push(new Paragraph({ text: '' }));
        }
      } else if (line) {
        // Accumulate paragraph text
        currentParagraphLines.push(line);
      }
    }
    
    // Flush remaining paragraph
    if (currentParagraphLines.length > 0) {
      const paragraphText = currentParagraphLines.join(' ').trim();
      if (paragraphText) {
        children.push(
          new Paragraph({
            children: [new TextRun({
              text: paragraphText,
              size: fontSize,
              font: fontName
            })],
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 200, line: lineSpacing, lineRule: 'auto' }
          })
        );
      }
    }
    
    // References are already embedded in formatted_text; do not append a second section.
    
    // Create document with proper margins
    let marginValue = 1; // default to 1 inch
    if (formatting_settings?.margins) {
      const marginStr = formatting_settings.margins.toString().replace(/[^0-9.]/g, '');
      marginValue = parseFloat(marginStr) || 1;
    }
    const marginTwips = marginValue * 1440; // Convert inches to twips
    
    const docxPageNumberConfig = getDocxPageNumberConfig(
      formatting_settings?.page_numbers,
      fontName,
      fontSize
    );

    const doc = new Document({
      sections: [{
        properties: new SectionProperties({
          page: {
            margins: {
              top: marginTwips,
              right: marginTwips,
              bottom: marginTwips,
              left: marginTwips
            }
          }
        }),
        ...docxPageNumberConfig,
        children
      }]
    });
    
    const docxBuffer = await Packer.toBuffer(doc);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${paper_title || 'formatted-paper'}.docx"`);
    return res.send(docxBuffer);
  } catch (error) {
    console.error('DOCX export error:', error.message);
    console.error('Full error:', error);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: `DOCX export failed: ${error.message}` });
  }
});

// ========== CITATION ENDPOINTS ==========

// POST /api/citations/bibtex — Export citations as BibTeX
app.post('/api/citations/bibtex', (req, res) => {
  const { citations } = req.body || {};
  
  if (!citations || !Array.isArray(citations)) {
    return res.status(400).json({ error: 'Invalid citations array' });
  }
  
  try {
    const bibtex = citations
      .map((c, i) => {
        return `@article{${c.author}${c.year},
  author = {${c.author}},
  year = {${c.year}},
  title = {[Title to be filled]},
  journal = {[Journal to be filled]}
}`;
      })
      .join('\n\n');
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="citations.bib"');
    return res.send(bibtex);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/citations/format — Format citations in different styles
app.post('/api/citations/format', (req, res) => {
  const { citations, style } = req.body || {};
  
  if (!citations || !Array.isArray(citations) || !style) {
    return res.status(400).json({ error: 'Citations and style required' });
  }
  
  try {
    let formatted = [];
    
    citations.forEach(c => {
      let entry = '';
      switch (style.toUpperCase()) {
        case 'APA':
          entry = `${c.author} (${c.year}). [Title]. [Journal].`;
          break;
        case 'MLA':
          entry = `${c.author}. "[Title]." [Journal], ${c.year}.`;
          break;
        case 'CHICAGO':
          entry = `${c.author}. "[Title]." [Journal] (${c.year}).`;
          break;
        default:
          entry = `${c.author}, ${c.year}`;
      }
      formatted.push(entry);
    });
    
    return res.json({ citations: formatted, style });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ========== PLAGIARISM & PROOFREADING ==========

// POST /api/proofread — Check for grammar, style, and readability issues
app.post('/api/proofread', async (req, res) => {
  const { text } = req.body || {};
  
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }
  
  try {
    const prompt = `Review this academic text for:
    1. Grammar and spelling errors
    2. Academic tone and clarity
    3. Sentence structure and flow
    4. Suggested improvements
    
    Text: ${text.substring(0, 1000)}
    
    Return JSON with { errors: [...], suggestions: [...], score: 0-100 }`;
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500
    });
    
    const response = completion.choices[0].message.content;
    
    // Try to parse JSON, fallback to simple response
    let result = { errors: [], suggestions: [], score: 85 };
    try {
      result = JSON.parse(response);
    } catch (e) {
      result.feedback = response;
    }
    
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/plagiarism/check — Plagiarism check stub (returns mock data)
app.post('/api/plagiarism/check', async (req, res) => {
  const { text } = req.body || {};
  
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }
  
  try {
    // Mock plagiarism detection (for MVP)
    // In production, integrate with Copyscape, Turnitin, or similar
    const similarity = Math.floor(Math.random() * 20); // 0-20% for demo
    
    return res.json({
      similarity_percentage: similarity,
      status: similarity < 15 ? 'PASS' : 'WARNING',
      message: similarity < 15 
        ? 'Text appears to be original' 
        : 'Some sections may be similar to existing content. Review suggested matches.',
      matches: similarity > 0 ? [
        { url: 'https://example.com/paper1', similarity: Math.floor(Math.random() * 10) },
        { url: 'https://example.com/paper2', similarity: Math.floor(Math.random() * 10) }
      ] : []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ========== GOOGLE DOCS INTEGRATION STUB ==========

// POST /api/integrations/googledocs/connect — OAuth stub
app.post('/api/integrations/googledocs/connect', (req, res) => {
  const { code } = req.body || {};
  
  // In production, exchange code for refresh token
  return res.json({
    status: 'auth_required',
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=https://www.googleapis.com/auth/drive.file&...'
  });
});

// POST /api/integrations/googledocs/export — Export to Google Docs (stub)
app.post('/api/integrations/googledocs/export', (req, res) => {
  const { title, html, accessToken } = req.body || {};
  
  // In production, use Google Docs API to create document
  return res.json({
    status: 'Document creation requires Google API setup',
    doc_id: 'demo-doc-id-would-go-here',
    url: 'https://docs.google.com/document/d/demo-id/edit'
  });
});

// ========== PAPERS & HISTORY ==========

// GET /api/papers — Get user's papers
app.get('/api/papers', verifyToken, (req, res) => {
  db.all(
    'SELECT id, title, created_at FROM papers WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId],
    (err, papers) => {
      if (err) return res.status(500).json({ error: err.message });
      return res.json(papers || []);
    }
  );
});

// GET /api/papers/:id — Get specific paper
app.get('/api/papers/:id', verifyToken, (req, res) => {
  const { id } = req.params;
  
  db.get(
    'SELECT * FROM papers WHERE id = ? AND user_id = ?',
    [id, req.userId],
    (err, paper) => {
      if (err || !paper) {
        return res.status(404).json({ error: 'Paper not found' });
      }
      
      paper.citations = JSON.parse(paper.citations || '[]');
      return res.json(paper);
    }
  );
});

// ========== TEMPLATES & SETTINGS ==========

// GET /api/templates
app.get('/api/templates', (req, res) => {
  const templates = {
    styles: ['APA', 'MLA', 'Chicago', 'IEEE'],
    formats: [
      { name: 'Essay', description: 'Standard essay format' },
      { name: 'Research Paper', description: 'Research paper with abstract' },
      { name: 'Thesis', description: 'Thesis/dissertation format' },
      { name: 'Report', description: 'Professional report format' }
    ],
    integrations: [
      { name: 'Google Docs', status: 'Coming soon' },
      { name: 'Zotero', status: 'Coming soon' },
      { name: 'Mendeley', status: 'Coming soon' }
    ]
  };
  return res.json(templates);
});

// GET /api/formatting-styles — Available formatting options
app.get('/api/formatting-styles', (req, res) => {
  return res.json({
    styles: ['APA 7', 'MLA', 'Chicago'],
    fonts: ['Times New Roman', 'Arial', 'Calibri', 'Georgia'],
    fontSizes: [10, 11, 12, 13, 14],
    lineSpacings: ['Single', '1.5', 'Double'],
    margins: ['0.5 inch', '0.75 inch', '1 inch', '1.25 inch'],
    pageNumbers: ['Top Right', 'Top Center', 'Bottom Right', 'Bottom Center', 'None'],
    referencePageTitles: {
      'APA 7': 'References',
      'MLA': 'Works Cited',
      'Chicago': 'Bibliography'
    }
  });
});

// Health check with lightweight dependency verification for monitoring.
app.get('/', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'scholarflow-backend',
    message: 'Backend is running. Use /health for health checks.'
  });
});

app.get('/health', (req, res) => {
  db.get('SELECT 1 AS ok', [], (err) => {
    if (err) {
      return res.status(503).json({
        status: 'degraded',
        service: 'scholarflow-backend',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        checks: {
          database: 'down'
        }
      });
    }

    return res.status(200).json({
      status: 'ok',
      service: 'scholarflow-backend',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      checks: {
        database: 'up'
      }
    });
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`PaperSet backend listening on http://localhost:${PORT}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`Database: SQLite (${DB_PATH})`);
});
