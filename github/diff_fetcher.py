from __future__ import annotations

import requests


class GitHubDiffError(Exception):
    pass


def fetch_pr_diff(repo_full_name: str, pr_number: int, token: str = "") -> str:
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    headers = {
        "Accept": "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    response = requests.get(url, headers=headers, timeout=25)
    if response.status_code >= 400:
        raise GitHubDiffError(f"Failed to fetch PR diff ({response.status_code})")
    return response.text


def parse_unified_diff(diff_text: str) -> list[dict[str, str]]:
    file_sections: list[dict[str, str]] = []
    current_file = None
    current_lines: list[str] = []

    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            if current_file:
                file_sections.append({"file": current_file, "patch": "\n".join(current_lines)})
            current_lines = [line]
            parts = line.split(" b/")
            current_file = parts[-1] if len(parts) > 1 else "unknown"
        else:
            current_lines.append(line)

    if current_file:
        file_sections.append({"file": current_file, "patch": "\n".join(current_lines)})

    return file_sections
