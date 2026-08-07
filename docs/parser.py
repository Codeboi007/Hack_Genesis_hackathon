from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from docs.repo_loader import read_text_safe

IMPORT_PATTERNS = {
    ".py": re.compile(r"^(?:from\s+([\w\.]+)\s+import|import\s+([\w\.]+))", re.MULTILINE),
    ".js": re.compile(r"(?:import\s+.*?from\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\))"),
    ".ts": re.compile(r"(?:import\s+.*?from\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\))"),
    ".tsx": re.compile(r"(?:import\s+.*?from\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\))"),
    ".jsx": re.compile(r"(?:import\s+.*?from\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\))"),
    ".v": re.compile(r"^\s*`include\s+\"([^\"]+)\"", re.MULTILINE),
    ".sv": re.compile(r"^\s*`include\s+\"([^\"]+)\"", re.MULTILINE),
    ".vh": re.compile(r"^\s*`include\s+\"([^\"]+)\"", re.MULTILINE),
    ".svh": re.compile(r"^\s*`include\s+\"([^\"]+)\"", re.MULTILINE),
}


def _parse_python_symbols(code: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    functions: list[dict[str, Any]] = []
    classes: list[dict[str, Any]] = []
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return functions, classes

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            functions.append(
                {
                    "name": node.name,
                    "line": node.lineno,
                    "end_line": getattr(node, "end_lineno", node.lineno),
                    "args": [arg.arg for arg in node.args.args],
                }
            )
        elif isinstance(node, ast.ClassDef):
            classes.append(
                {
                    "name": node.name,
                    "line": node.lineno,
                    "end_line": getattr(node, "end_lineno", node.lineno),
                    "methods": [n.name for n in node.body if isinstance(n, ast.FunctionDef)],
                }
            )
    return functions, classes


def _parse_generic_symbols(code: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fn_pattern = re.compile(
        r"(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*\(|def\s+(\w+)\s*\(|task\s+(?:automatic\s+)?(\w+)\b)"
    )
    cls_pattern = re.compile(r"(?:class\s+(\w+)|module\s+(\w+)\b)")

    functions: list[dict[str, Any]] = []
    classes: list[dict[str, Any]] = []
    for i, line in enumerate(code.splitlines(), start=1):
        f_match = fn_pattern.search(line)
        if f_match:
            name = next((g for g in f_match.groups() if g), "anonymous")
            functions.append({"name": name, "line": i, "end_line": i, "args": []})
        c_match = cls_pattern.search(line)
        if c_match:
            name = next((g for g in c_match.groups() if g), "anonymous")
            classes.append({"name": name, "line": i, "end_line": i, "methods": []})
    return functions, classes


def parse_file(path: Path) -> dict[str, Any]:
    code = read_text_safe(path)
    ext = path.suffix.lower()

    if ext == ".py":
        functions, classes = _parse_python_symbols(code)
    else:
        functions, classes = _parse_generic_symbols(code)

    pattern = IMPORT_PATTERNS.get(ext)
    imports: list[str] = []
    if pattern:
        for match in pattern.findall(code):
            if isinstance(match, tuple):
                imports.extend([x for x in match if x])
            elif match:
                imports.append(match)

    return {
        "path": str(path),
        "language": ext.lstrip("."),
        "imports": sorted(set(imports)),
        "functions": functions,
        "classes": classes,
        "line_count": len(code.splitlines()),
        "content": code,
    }


def parse_repository(files: list[Path]) -> list[dict[str, Any]]:
    return [parse_file(path) for path in files]
