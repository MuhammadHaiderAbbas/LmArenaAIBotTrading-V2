"""Build a minimal valid multi-page PDF with real text objects (no external deps)."""


def make_pdf(pages: list[str]) -> bytes:
    objs: list[bytes] = []
    n_pages = len(pages)
    page_ids = [3 + i * 2 for i in range(n_pages)]
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    font_id = 3 + n_pages * 2
    for i, text in enumerate(pages):
        content_id = page_ids[i] + 1
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                    f"/Contents {content_id} 0 R >>".encode())
        lines = []
        for j, line in enumerate(text.split("\n")):
            safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            lines.append(f"BT /F1 11 Tf 50 {740 - j * 16} Td ({safe}) Tj ET")
        stream = "\n".join(lines).encode()
        objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream
                    + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def make_scanned_pdf(text: str) -> bytes:
    """Build a PDF whose only content is a raster image (no text layer)."""
    from io import BytesIO

    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1000, 300), "white")
    draw = ImageDraw.Draw(image)
    draw.text((30, 40), text, fill="black", font=ImageFont.load_default(size=34))
    draw.text((30, 110), "Scanned quarterly report", fill="black",
              font=ImageFont.load_default(size=26))
    buf = BytesIO()
    image.save(buf, "PDF", resolution=150)
    return buf.getvalue()
