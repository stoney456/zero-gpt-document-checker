#!/usr/bin/env python3
"""
PDF Report Generator
Combines contribution charts and AI plagiarism analysis into a single PDF report.

Usage:
    python report.py --charts <charts_folder> --analysis <ai-analysis.txt> [--output <report.pdf>] [--title <title>]

Requirements:
    pip install reportlab
"""

import argparse
import os
import re
import sys
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image,
    PageBreak, HRFlowable, KeepTogether
)

PAGE_W, PAGE_H = A4
MARGIN = 2 * cm

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# ── STYLES ────────────────────────────────────────────────────────────────────

def make_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        "ReportTitle", parent=styles["Title"],
        fontSize=24, leading=30, spaceAfter=6,
        textColor=colors.HexColor("#1a1a2e"),
    ))
    styles.add(ParagraphStyle(
        "ReportSubtitle", parent=styles["Normal"],
        fontSize=11, textColor=colors.HexColor("#6b7280"), spaceAfter=20,
    ))
    styles.add(ParagraphStyle(
        "SectionHeading", parent=styles["Heading1"],
        fontSize=14, leading=18, spaceBefore=18, spaceAfter=8,
        textColor=colors.HexColor("#1a1a2e"), borderPad=4,
    ))
    styles.add(ParagraphStyle(
        "ChartCaption", parent=styles["Normal"],
        fontSize=9, textColor=colors.HexColor("#6b7280"),
        alignment=1, spaceAfter=16,
    ))
    styles.add(ParagraphStyle(
        "AnalysisBody", parent=styles["Normal"],
        fontSize=10, leading=15, spaceAfter=6,
        textColor=colors.HexColor("#1f2937"),
    ))
    styles.add(ParagraphStyle(
        "AnalysisUserHeading", parent=styles["Heading2"],
        fontSize=12, leading=16, spaceBefore=14, spaceAfter=6,
        textColor=colors.HexColor("#2563eb"),
    ))
    return styles

# ── HELPERS ───────────────────────────────────────────────────────────────────

def chart_image(path, max_width=None, max_height=None):
    if max_width is None:
        max_width = PAGE_W - 2 * MARGIN
    if max_height is None:
        max_height = PAGE_H * 0.55
    img = Image(path)
    w, h = img.drawWidth, img.drawHeight
    scale = min(max_width / w, max_height / h, 1.0)
    img.drawWidth  = w * scale
    img.drawHeight = h * scale
    return img

def hr():
    return HRFlowable(width="100%", thickness=1,
                      color=colors.HexColor("#e5e7eb"), spaceAfter=8)

def clean_line(line):
    line = re.sub(r'<[^>]+>', '', line)
    line = re.sub(r'[*]{1,3}(.*?)[*]{1,3}', lambda m: m.group(1), line)
    line = re.sub(r'_{1,2}(.*?)_{1,2}',     lambda m: m.group(1), line)
    line = re.sub(r'^[#]{1,6}\s*',          '', line)
    line = re.sub(r'`(.*?)`',               lambda m: m.group(1), line)
    line = re.sub(r'^\s*[-*]\s+',           '', line)
    return line.strip()

def safe_xml(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def parse_analysis(text):
    """
    Parse the AI analysis text into (username, body_lines) tuples.
    Detects section boundaries via 'User: <name>' lines.
    """
    sections = []
    current_heading = None
    current_lines = []

    for line in text.splitlines():
        stripped = line.strip()

        # New user section — "User: SomeName"
        m = re.match(r'(?i)^user:\s+(.+)', stripped)
        if m:
            username = m.group(1).strip()
            if username:
                if current_heading is not None:
                    sections.append((current_heading, current_lines))
                current_heading = username
                current_lines = []
            continue

        # Skip the header block at top of file (File ID / Generated / === lines)
        if current_heading is None:
            continue

        current_lines.append(line)

    if current_heading is not None and current_lines:
        sections.append((current_heading, current_lines))

    return sections

# ── RENDER ────────────────────────────────────────────────────────────────────

def render_analysis_section(story, sections, styles):
    for heading, lines in sections:
        if not heading.strip():
            continue

        story.append(Paragraph(
            f'<font color="#2563eb"><b>User:</b></font> <b>{safe_xml(heading)}</b>',
            styles["AnalysisUserHeading"]
        ))

        i = 0
        while i < len(lines):
            stripped = lines[i].strip()
            cleaned  = clean_line(stripped)

            if not cleaned:
                story.append(Spacer(1, 4))
                i += 1
                continue

            # Skip repeated user lines and dividers
            if re.match(r'(?i)^user:\s*', stripped) or stripped.startswith("---") or stripped.startswith("==="):
                i += 1
                continue

            safe = safe_xml(cleaned)

            # AI Plagiarism Percentage
            if re.match(r'(?i)^ai plagiarism percentage\s*:', stripped):
                parts = safe.split(":", 1)
                label = parts[0].strip()
                value = parts[1].strip() if len(parts) > 1 else ""
                story.append(Paragraph(f"<b>{label}:</b> <b>{value}</b>", styles["AnalysisBody"]))

            # Analysis
            elif re.match(r'(?i)^analysis\s*:', stripped):
                value = re.sub(r'(?i)^analysis\s*:\s*', '', safe).strip()
                story.append(Paragraph(f"<b>Analysis:</b> {value}", styles["AnalysisBody"]))

            # Specific Excerpts header
            elif re.match(r'(?i)^specific excerpts\s*:', stripped):
                story.append(Spacer(1, 6))
                story.append(Paragraph("<b>Specific Excerpts:</b>", styles["AnalysisBody"]))

            # Excerpt N:
            elif re.match(r'(?i)^excerpt\s*\d+\s*:', stripped):
                m = re.match(r'(?i)^(excerpt\s*\d+)\s*:\s*(.*)', stripped)
                label       = safe_xml(m.group(1).strip()) if m else "Excerpt"
                excerpt_txt = safe_xml(clean_line(m.group(2).strip())) if m else safe
                story.append(Spacer(1, 6))
                story.append(Paragraph(
                    f'<b>{label}:</b> <i>"{excerpt_txt}"</i>',
                    styles["AnalysisBody"]
                ))

            # Explanation
            elif re.match(r'(?i)^explanation\s*(\(must show\))?\s*:', stripped):
                m = re.match(r'(?i)^explanation\s*(\(must show\))?\s*:\s*(.*)', stripped)
                explanation = safe_xml(clean_line(m.group(2).strip())) if m else safe
                story.append(Paragraph(explanation, styles["AnalysisBody"]))
                story.append(Spacer(1, 8))

            # Regular body line
            else:
                story.append(Paragraph(safe, styles["AnalysisBody"]))

            i += 1

        story.append(Spacer(1, 10))

# BUILD PDF

CHART_META = [
    ("contribution-pie.png",                    "Overall Net Word Contribution - Pie Chart"),
    ("contribution-line-networds.png",          "Progressive Net Word Contribution Over Time"),
    ("contribution-line-netchars.png",          "Progressive Net Character Contribution Over Time"),
    ("contribution-line-revision-networds.png", "Net Word Contribution by Revision Number"),
    ("contribution-line-revision-netchars.png", "Net Character Contribution by Revision Number"),
    ("contribution-heatmap-networds.png",       "Contribution Heatmap by Date and Contributor"),
]

def build_pdf(charts_folder, analysis_path, output_path, title):
    styles = make_styles()
    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN,
        title=title,
    )

    story = []
    generated = None

    # Ensures that the report shows exact time generated in SGT
    if analysis_path and os.path.exists(analysis_path):
        with open(analysis_path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("Generated:"):
                    generated = line.replace("Generated:", "").strip()
                    break
    if not generated:
        from datetime import timezone, timedelta
        sgt = timezone(timedelta(hours=8))
        generated = datetime.now(sgt).strftime("%d %B %Y, %H:%M SGT")

    # Cover
    story.append(Spacer(1, 2 * cm))
    story.append(Paragraph(title, styles["ReportTitle"]))
    story.append(Paragraph(f"Generated: {generated}", styles["ReportSubtitle"]))
    story.append(hr())
    story.append(Spacer(1, 0.5 * cm))
    print("[PDF-PROGRESS] 1/4")

    # Charts
    story.append(Paragraph("Contribution Charts", styles["SectionHeading"]))
    story.append(hr())

    found_any_chart = False
    for filename, caption in CHART_META:
        path = os.path.join(charts_folder, filename)
        if not os.path.exists(path):
            continue
        found_any_chart = True
        story.append(Spacer(1, 0.3 * cm))
        story.append(KeepTogether([
            chart_image(path),
            Paragraph(caption, styles["ChartCaption"]),
        ]))

    if not found_any_chart:
        story.append(Paragraph(
            "No chart files found. Run charts.py first to generate them.",
            styles["AnalysisBody"]
        ))
    print("[PDF-PROGRESS] 2/4")

    # AI Analysis
    story.append(PageBreak())
    story.append(Paragraph("AI Plagiarism Analysis", styles["SectionHeading"]))
    story.append(hr())

    if analysis_path and os.path.exists(analysis_path):
        with open(analysis_path, encoding="utf-8") as f:
            raw = f.read()

        sections = parse_analysis(raw)

        if sections:
            render_analysis_section(story, sections, styles)
        else:
            story.append(Paragraph(
                "Analysis file was found but contained no user sections. "
                "Check that analysis.js ran successfully and produced output.",
                styles["AnalysisBody"]
            ))
    else:
        story.append(Paragraph(
            "No AI analysis file found. Run analysis.js with GEMINI_API_KEY set to generate it.",
            styles["AnalysisBody"]
        ))

    doc.build(story)
    print("[PDF-PROGRESS] 4/4")
    print(f"PDF report saved: {output_path}")
    

# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Combine contribution charts and AI analysis into a PDF report.")
    parser.add_argument("--charts",   required=True)
    parser.add_argument("--analysis", default=None)
    parser.add_argument("--output",   default="contribution-report.pdf")
    parser.add_argument("--title",    default="Contribution Report")
    args = parser.parse_args()

    if not os.path.isdir(args.charts):
        print(f"Charts folder not found: {args.charts}")
        sys.exit(1)

    build_pdf(args.charts, args.analysis, args.output, args.title)

if __name__ == "__main__":
    main()