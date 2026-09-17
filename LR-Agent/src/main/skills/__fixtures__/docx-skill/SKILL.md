---
name: docx-demo
description: 测试夹具 skill：用标准库生成/修改/读取最小 docx（供 skillScriptRunner 自动化测试与执行链路演示）
---

# docx-demo（测试夹具）

演示 Skill 脚本执行的最小 docx 工作流，全部脚本仅依赖 Python 标准库。

## 脚本

- `scripts/make_docx.py <output.docx> <title> [paragraph ...]`：生成最小 docx（首段为标题，其余为正文段落）
- `scripts/edit_docx.py <file.docx> <find> <replace>`：把文档内 find 首次出现的文本替换为 replace（就地修改）
- `scripts/read_text.py <file.docx>`：输出全部段落文本（每段一行）

## 用法示例

```bash
python scripts/make_docx.py report.docx "测试报告" "第一段内容" "第二段内容"
python scripts/edit_docx.py report.docx "第一段内容" "已修改内容"
python scripts/read_text.py report.docx
```
