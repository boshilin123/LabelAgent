"""生成最小 docx（OOXML 最小包：[Content_Types].xml + _rels/.rels + word/document.xml）。

用法：make_docx.py <output.docx> <title> [paragraph ...]
仅依赖标准库，供 skillScriptRunner 执行链路测试使用。
"""

import sys
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""

DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
{paragraphs}
    <w:sectPr/>
  </w:body>
</w:document>
"""

PARAGRAPH = '    <w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: make_docx.py <output.docx> <title> [paragraph ...]")
        return 2
    output, title = sys.argv[1], sys.argv[2]
    texts = [title, *sys.argv[3:]]
    paragraphs = "\n".join(PARAGRAPH.format(text=escape(t)) for t in texts)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES)
        zf.writestr("_rels/.rels", RELS)
        zf.writestr("word/document.xml", DOCUMENT.format(paragraphs=paragraphs))
    print(f"created {output} with {len(texts)} paragraphs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
