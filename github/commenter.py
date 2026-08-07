from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"


def format_inline_comments(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Format agent findings into GitHub review comment payloads."""
    comments = []
    for finding in findings:
        comments.append(
            {
                "path": finding["file"],
                "line": finding["line"],
                "body": (
                    f"**[{finding['severity'].upper()}] {finding['issue_title']}**\n\n"
                    f"{finding['explanation']}\n\n"
                    f"**Suggested fix:** {finding['fix_suggestion']}\n\n"
                    f"*Agent: {finding['agent']} · Confidence: {int(finding['confidence'] * 100)}%*"
                ),
            }
        )
    return comments


def post_pr_review(
    repo_full_name: str,
    pr_number: int,
    token: str,
    findings: list[dict[str, Any]],
    summary: str,
) -> bool:
    """
    Post a GitHub pull request review with inline comments and a summary body.

    Returns True if the review was posted successfully, False otherwise.
    Errors are logged but not re-raised so the webhook always ACKs.
    """
    if not token:
        logger.info("No GitHub token — skipping PR review post for %s#%d", repo_full_name, pr_number)
        return False

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Build inline comments — GitHub requires 'position' or 'line' (line is preferred for diff-relative)
    # We use the pull_request_review endpoint with COMMENT event so all are posted atomically.
    comments = []
    for finding in findings:
        # GitHub requires line to be within the diff; we clip to at least 1.
        comments.append(
            {
                "path": finding["file"],
                "line": max(1, int(finding["line"])),
                "side": "RIGHT",
                "body": (
                    f"**[{finding['severity'].upper()}] {finding['issue_title']}**\n\n"
                    f"{finding['explanation']}\n\n"
                    f"**Suggested fix:** {finding['fix_suggestion']}\n\n"
                    f"*Agent: {finding['agent']} · Confidence: {int(finding['confidence'] * 100)}%*"
                ),
            }
        )

    review_body = (
        f"## 🤖 AI Code Review\n\n{summary}\n\n"
        f"*{len(findings)} finding(s) detected across {len({f['file'] for f in findings})} file(s).*"
    ) if summary else (
        f"## 🤖 AI Code Review\n\n"
        f"*{len(findings)} finding(s) detected across {len({f['file'] for f in findings})} file(s).*"
    )

    review_url = f"{GITHUB_API}/repos/{repo_full_name}/pulls/{pr_number}/reviews"
    payload: dict[str, Any] = {
        "body": review_body,
        "event": "COMMENT",
        "comments": comments[:30],  # GitHub allows max 50 inline comments per review
    }

    try:
        response = requests.post(review_url, json=payload, headers=headers, timeout=20)
        if response.status_code >= 400:
            logger.warning(
                "Failed to post PR review to %s#%d: HTTP %d — %s",
                repo_full_name,
                pr_number,
                response.status_code,
                response.text[:300],
            )
            # If inline comments fail (e.g. files not in diff), fall back to a plain issue comment
            return _post_summary_comment(repo_full_name, pr_number, headers, review_body)
        logger.info("Posted PR review to %s#%d (%d inline comments)", repo_full_name, pr_number, len(comments))
        return True
    except Exception as exc:
        logger.warning("Exception posting PR review to %s#%d: %s", repo_full_name, pr_number, exc)
        return _post_summary_comment(repo_full_name, pr_number, headers, review_body)


def _post_summary_comment(
    repo_full_name: str,
    pr_number: int,
    headers: dict[str, str],
    body: str,
) -> bool:
    """Fallback: post a plain issue comment on the PR if inline review posting failed."""
    url = f"{GITHUB_API}/repos/{repo_full_name}/issues/{pr_number}/comments"
    try:
        response = requests.post(url, json={"body": body}, headers=headers, timeout=20)
        if response.status_code >= 400:
            logger.warning(
                "Fallback summary comment also failed for PR#%d: HTTP %d",
                pr_number,
                response.status_code,
            )
            return False
        logger.info("Posted fallback summary comment on PR#%d", pr_number)
        return True
    except Exception as exc:
        logger.warning("Exception posting fallback summary comment: %s", exc)
        return False


def push_readme_to_github(
    repo_full_name: str,
    token: str,
    readme_content: str,
    branch: str = "main",
    path: str = "README.md",
    commit_message: str = "docs: auto-generated README by AI Developer Platform 🤖",
) -> bool:
    """
    Create or update README.md in the target GitHub repo via the Contents API.

    - If the file already exists, fetches its SHA first (required for updates).
    - Falls back to 'master' branch if 'main' is not found.
    - Returns True on success, False on any error (errors are logged, not raised).
    """
    import base64

    if not token:
        logger.info("No GitHub token — skipping README push for %s", repo_full_name)
        return False

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Resolve default branch up-front so repos without "main" still work.
    try:
        repo_url = f"{GITHUB_API}/repos/{repo_full_name}"
        repo_resp = requests.get(repo_url, headers=headers, timeout=15)
        if repo_resp.status_code == 200:
            default_branch = repo_resp.json().get("default_branch")
            if isinstance(default_branch, str) and default_branch.strip():
                branch = default_branch.strip()
        else:
            logger.warning(
                "Could not resolve default branch for %s: HTTP %d",
                repo_full_name,
                repo_resp.status_code,
            )
    except Exception as exc:
        logger.warning("Exception resolving default branch for %s: %s", repo_full_name, exc)

    encoded = base64.b64encode(readme_content.encode("utf-8")).decode("ascii")
    url = f"{GITHUB_API}/repos/{repo_full_name}/contents/{path}"

    # Try to get the current file SHA (needed if file already exists)
    current_sha: str | None = None
    candidate_branches: list[str] = []
    for candidate in [branch, "main", "master"]:
        if candidate not in candidate_branches:
            candidate_branches.append(candidate)
    for attempt_branch in candidate_branches:
        try:
            r = requests.get(url, headers=headers, params={"ref": attempt_branch}, timeout=15)
            if r.status_code == 200:
                current_sha = r.json().get("sha")
                branch = attempt_branch  # use whichever branch actually exists
                break
            elif r.status_code == 404:
                continue  # file doesn't exist yet — that's fine
        except Exception as exc:
            logger.warning("Could not fetch current %s from %s: %s", path, repo_full_name, exc)

    payload: dict[str, Any] = {
        "message": commit_message,
        "content": encoded,
        "branch": branch,
    }
    if current_sha:
        payload["sha"] = current_sha

    try:
        response = requests.put(url, json=payload, headers=headers, timeout=20)
        if response.status_code in (200, 201):
            action = "Updated" if current_sha else "Created"
            logger.info("%s %s in %s on branch %s", action, path, repo_full_name, branch)
            return True
        logger.warning(
            "Failed to push %s to %s: HTTP %d — %s",
            path, repo_full_name, response.status_code, response.text[:300],
        )
        return False
    except Exception as exc:
        logger.warning("Exception pushing %s to %s: %s", path, repo_full_name, exc)
        return False


def verify_docs_token_access(repo_full_name: str, token: str) -> tuple[bool, str, str]:
    """
    Validate that the provided token can access the repository and likely write contents.
    Returns: (valid, default_branch, message)
    """
    if not token:
        return False, "", "Token is empty"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    repo_url = f"{GITHUB_API}/repos/{repo_full_name}"
    try:
        response = requests.get(repo_url, headers=headers, timeout=15)
        if response.status_code == 401:
            return False, "", "Unauthorized token. Check PAT value."
        if response.status_code == 404:
            return False, "", "Repository not found for this token."
        if response.status_code >= 400:
            return False, "", f"GitHub API error (HTTP {response.status_code})."

        payload = response.json()
        default_branch = str(payload.get("default_branch") or "").strip()
        perms = payload.get("permissions") or {}
        can_push = bool(perms.get("push")) if isinstance(perms, dict) else False
        if not can_push:
            return (
                False,
                default_branch,
                "Token can read repo but cannot push. Grant Contents: Read and write.",
            )
        return True, default_branch, "Token validated for README create/update."
    except Exception as exc:
        logger.warning("Token verification failed for %s: %s", repo_full_name, exc)
        return False, "", "Could not validate token with GitHub."

