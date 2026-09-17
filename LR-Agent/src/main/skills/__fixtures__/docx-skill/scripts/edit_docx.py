"""就地修改 docx：把 word/document.xml 中首次出现的 find 替换为 replace。

用法：edit_docx.py <file.docx> <find> <replace>
仅依赖标准库；重写 zip 时保持其余条目不变。
"""

import sys
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DOCUMENT_PART = "word/document.xml"


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: edit_docx.py <file.docx> <find> <replace>")
        return 2
    path, find, replace = sys.argv[1], sys.argv[2], sys.argv[3]

    with zipfile.ZipFile(path, "r") as zin:
        entries = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    if DOCUMENT_PART not in entries:
        print("error: word/document.xml not found (not a docx?)")
        return 1

    xml = entries[DOCUMENT_PART].decode("utf-8")
    if find not in xml:
        print(f"error: text not found: {find}")
        return 1
    entries[DOCUMENT_PART] = xml.replace(find, replace, 1).encode("utf-8")

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in entries.items():
            zout.writestr(name, data)
    print(f"edited {path}: replaced {find!r} once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
