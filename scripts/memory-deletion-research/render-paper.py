#!/usr/bin/env python3
"""Render a small, deliberately portable Markdown subset as an A4 paper PDF."""
import argparse
import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    Image, KeepTogether, Paragraph, Preformatted, SimpleDocTemplate,
    Spacer, Table, TableStyle, PageBreak,
)


def register_fonts(font=None):
    """Embed an installed TrueType CJK font; keep a portable CID fallback."""
    candidates = [Path(font)] if font else [
        Path('/System/Library/Fonts/STHeiti Light.ttc'),
        Path('/usr/share/fonts/truetype/arphic/uming.ttc'),
        Path('C:/Windows/Fonts/simsun.ttc'),
    ]
    for candidate in candidates:
        if candidate.is_file():
            pdfmetrics.registerFont(TTFont('PaperCJK', str(candidate), subfontIndex=0))
            bold = Path('/System/Library/Fonts/STHeiti Medium.ttc')
            pdfmetrics.registerFont(TTFont('PaperCJKBold', str(bold if bold.is_file() and not font else candidate), subfontIndex=0))
            pdfmetrics.registerFontFamily('PaperCJK', normal='PaperCJK', bold='PaperCJKBold', italic='PaperCJK', boldItalic='PaperCJKBold')
            return 'PaperCJK', 'PaperCJKBold'
    if font:
        raise FileNotFoundError(f'CJK TrueType font not found: {font}')
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    pdfmetrics.registerFontFamily('STSong-Light', normal='STSong-Light', bold='STSong-Light', italic='STSong-Light', boldItalic='STSong-Light')
    print('Using unembedded STSong-Light; pass --font to embed a CJK TrueType font.')
    return 'STSong-Light', 'STSong-Light'


def inline(text):
    """Escape source text before adding the few supported ReportLab XML tags."""
    text = html.escape(text.strip())
    text = re.sub(r"`([^`]+)`", r'<font name="Courier" size="8">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                  r'<link href="\2" color="#17436b">\1</link>', text)
    return text


def render(source, output, font=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    lines = source.read_text(encoding="utf-8").splitlines()
    output.parent.mkdir(parents=True, exist_ok=True)
    width = A4[0] - 42 * mm
    regular, bold = register_fonts(font)
    body = ParagraphStyle("PaperBody", fontName=regular, fontSize=10,
                          leading=14, wordWrap='CJK', spaceAfter=5.5, allowWidows=0, allowOrphans=0)
    table_body = ParagraphStyle("PaperCell", parent=body, fontSize=8,
                               leading=10, spaceAfter=0)
    code = ParagraphStyle("PaperCode", fontName="Courier", fontSize=7,
                          leading=9, spaceBefore=4, spaceAfter=6)
    headings = {
        1: ParagraphStyle("PaperTitle", parent=body, fontName=bold,
                          fontSize=20, leading=23, alignment=TA_CENTER,
                          spaceBefore=4, spaceAfter=14, keepWithNext=True),
        2: ParagraphStyle("PaperHeading", parent=body, fontName=bold,
                          fontSize=13, leading=16, spaceBefore=10,
                          spaceAfter=6, keepWithNext=True),
        3: ParagraphStyle("PaperSubheading", parent=body, fontName=bold,
                          fontSize=11, leading=14, spaceBefore=7,
                          spaceAfter=4, keepWithNext=True),
    }
    story, i = [], 0
    title = next((line[2:] for line in lines if line.startswith("# ")), source.stem)
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line in ("---", "***"):
            continue
        if line == '<!-- pagebreak -->':
            story.append(PageBreak())
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            story.append(Paragraph(inline(heading[2]), headings[min(len(heading[1]), 3)]))
        elif line.startswith("```"):
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1
            # Preformatted is plain text, unlike Paragraph: escaping here would
            # print literal &quot; and &amp; and corrupt copyable shell commands.
            story.append(Preformatted("\n".join(block), code, maxLineLength=100))
        elif re.fullmatch(r"!\[.*?\]\(.+\)", line):
            alt, path = re.match(r"!\[(.*?)\]\((.+)\)", line).groups()
            img = Image(str(source.parent / path), hAlign="CENTER")
            scale = min(width / img.imageWidth, 165 * mm / img.imageHeight, 1)
            img.drawWidth, img.drawHeight = img.imageWidth * scale, img.imageHeight * scale
            items = [img, Spacer(1, 3 * mm)]
            if alt:
                items.append(Paragraph(inline(alt), ParagraphStyle(
                    "Caption", parent=body, fontSize=9, leading=11, alignment=TA_CENTER)))
            story.append(KeepTogether(items))
        elif line.startswith("|"):
            rows = []
            while True:
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
                    rows.append(cells)
                if i >= len(lines) or not lines[i].strip().startswith("|"):
                    break
                line = lines[i].strip()
                i += 1
            columns = max(map(len, rows))
            weights = [max(min(len(row[c]) if c < len(row) else 0, 70) for row in rows)
                       + 12 for c in range(columns)]
            data = [[Paragraph(inline(cell), table_body) for cell in
                     (row + [""] * (columns - len(row)))] for row in rows]
            table = Table(data, colWidths=[width * w / sum(weights) for w in weights],
                          repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                ("LINEBELOW", (0, 0), (-1, 0), .6, colors.black),
                ("LINEBELOW", (0, -1), (-1, -1), .5, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.extend([KeepTogether([table]) if len(rows) <= 12 else table, Spacer(1, 3 * mm)])
        elif re.match(r"^([-*]|\d+\.)\s+", line):
            marker, content = line.split(" ", 1)
            story.append(Paragraph(inline(content), body,
                                   bulletText="-" if marker in ("-", "*") else marker))
        else:
            paragraph = [line]
            while i < len(lines) and lines[i].strip() and not re.match(
                    r"^(#|\||```|!\[|[-*]\s|\d+\.\s)", lines[i].strip()):
                paragraph.append(lines[i].strip())
                i += 1
            story.append(Paragraph(inline(" ".join(paragraph)), body))

    def page(canvas, document):
        canvas.saveState()
        canvas.setFont(regular, 8)
        canvas.setFillColor(colors.HexColor("#555555"))
        # Use the title's subject as a running head instead of cutting a long
        # subtitle in the middle of a word on every page.
        header = re.split(r'[：:]\s*', title, maxsplit=1)[0]
        if pdfmetrics.stringWidth(header, regular, 8) > width:
            while pdfmetrics.stringWidth(header + '...', regular, 8) > width:
                header = header[:-1]
            header += '...'
        canvas.drawString(21 * mm, A4[1] - 14 * mm, header)
        canvas.drawCentredString(A4[0] / 2, 12 * mm, str(document.page))
        canvas.restoreState()

    doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=21 * mm,
                            rightMargin=21 * mm, topMargin=22 * mm,
                            bottomMargin=20 * mm, title=title, author="")
    doc.build(story, onFirstPage=page, onLaterPages=page)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--font", type=Path, help="CJK TrueType font (.ttf or TrueType .ttc); embedded in PDF")
    args = parser.parse_args()
    render(args.source, args.out, args.font)
