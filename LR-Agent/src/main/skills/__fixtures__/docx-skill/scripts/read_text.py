"""读取 docx 全部段落文本（每段一行）。

用法：read_text.py <file.docx>
仅依赖标准库；按 word/document.xml 中 <w:t> 出现顺序输出，段落以 </w:p> 分界。
"""

import re
import sys
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DOCUMENT_PART = "word/document.xml"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: read_text.py <file.docx>")
        return 2

    try:
        with zipfile.ZipFile(sys.argv[1], "r") as zf:
            xml = zf.read(DOCUMENT_PART).decode("utf-8")
    except (FileNotFoundError, KeyError):
        print("error: cannot read document")
        return 1

    text_pattern = re.compile(r"<w:t[^>]*>(.*?)</w:t>", re.DOTALL)
    paragraphs = re.split(r"</w:p>", xml)
    count = 0
    for para in paragraphs:
        runs = text_pattern.findall(para)
        if runs:
            print("".join(runs))
            count += 1
    if count == 0:
        print("(empty document)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
