"""工作区文本文件策略。

- 读取/预览：用「二进制/富媒体后缀集合」判断是否可作为纯文本读取。
- 写盘/编辑：用「文本后缀白名单」，白名单之外一律禁止（默认拒绝），
  从根上阻断 agent 写入脚本/可执行文件再触发执行。

须与客户端同仓库的 src/shared/workspaceTextExtensions.ts 保持同步。
本服务内嵌于客户端 vendor/local-agent/，由 Electron 主进程 spawn。
"""

from __future__ import annotations

# 二进制/富媒体后缀：不可当纯文本读取（read_workspace_file / 搜索跳过）
TEXT_WRITE_BLOCKLIST: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".ico",
        ".svg",
        ".pdf",
        ".docx",
        ".doc",
        ".zip",
        ".rar",
        ".7z",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
    }
)

# read_workspace_file 禁止当纯文本读取的格式（与二进制集合一致）
TEXT_BLOCKLIST_SUFFIXES = TEXT_WRITE_BLOCKLIST

# 允许写盘/编辑的文本与代码后缀白名单（不含点，全小写）。
# 刻意排除 .bat/.cmd/.ps1/.psm1/.vbs/.wsf/.hta/.scr/.com/.msi/.jar/.reg/.lnk 等。
TEXT_WRITE_WHITELIST: frozenset[str] = frozenset(
    {
        # 文档
        "md",
        "markdown",
        "mdx",
        "txt",
        "text",
        "log",
        "rst",
        "adoc",
        "csv",
        "tsv",
        # 数据 / 配置
        "json",
        "jsonl",
        "ndjson",
        "jsonc",
        "yaml",
        "yml",
        "toml",
        "ini",
        "cfg",
        "conf",
        "config",
        "properties",
        "env",
        "gitignore",
        "gitattributes",
        "dockerignore",
        "editorconfig",
        "npmrc",
        "nvmrc",
        "lock",
        # 代码
        "js",
        "jsx",
        "mjs",
        "cjs",
        "ts",
        "tsx",
        "mts",
        "cts",
        "py",
        "pyw",
        "pyi",
        "java",
        "kt",
        "kts",
        "c",
        "h",
        "cc",
        "cpp",
        "cxx",
        "hpp",
        "hh",
        "hxx",
        "cs",
        "go",
        "rs",
        "rb",
        "php",
        "swift",
        "m",
        "mm",
        "lua",
        "r",
        "pl",
        "pm",
        "scala",
        "dart",
        "groovy",
        "gradle",
        "sh",
        "bash",
        "zsh",
        "fish",
        "sql",
        "html",
        "htm",
        "xml",
        "css",
        "scss",
        "sass",
        "less",
        "vue",
        "svelte",
        "astro",
        "graphql",
        "gql",
        "proto",
        "tf",
        "hcl",
        "dockerfile",
        "makefile",
        "cmake",
        "mk",
    }
)


def is_blocked_text_extension(ext: str) -> bool:
    """是否禁止写盘/编辑（白名单之外一律禁止）。

    与 TS 侧 isBlockedTextExtension 语义一致；二进制/富媒体读取拦截请用
    TEXT_BLOCKLIST_SUFFIXES。
    """
    return not is_allowed_text_extension(ext)


def is_allowed_text_extension(ext: str) -> bool:
    """仅白名单内的文本/代码后缀可写、可被 str_replace / delete 操作。

    无后缀（LICENSE、Makefile、.env、.gitignore 等 Path.suffix 为空）视为文本放行。
    """
    normalized = ext.lower().lstrip(".")
    if not normalized:
        return True
    return normalized in TEXT_WRITE_WHITELIST
