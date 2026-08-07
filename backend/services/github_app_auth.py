from __future__ import annotations

import time

import jwt
import requests


class GitHubAppAuthError(Exception):
    pass


class GitHubAppAuth:
    def __init__(self, app_id: str, private_key: str) -> None:
        self.app_id = app_id.strip()
        self.private_key = private_key.strip()

    @property
    def enabled(self) -> bool:
        return bool(self.app_id and self.private_key)

    def get_installation_token(self, installation_id: int) -> str:
        if not self.enabled:
            raise GitHubAppAuthError("GitHub App auth is not configured")

        app_jwt = self._build_jwt()
        url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
        headers = {
            "Authorization": f"Bearer {app_jwt}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

        response = requests.post(url, headers=headers, timeout=20)
        if response.status_code >= 400:
            raise GitHubAppAuthError(
                f"Failed to create installation token ({response.status_code}): {response.text[:240]}"
            )

        token = response.json().get("token")
        if not token:
            raise GitHubAppAuthError("GitHub installation token response did not include a token")
        return token

    def get_installation_token_for_repo(self, repo_full_name: str) -> str:
        """
        Resolve the installation ID for a specific repo, then get its access token.
        Uses GET /repos/{owner}/{repo}/installation (requires the App JWT).
        The Docs Push App must be installed on the target repo.
        """
        if not self.enabled:
            raise GitHubAppAuthError("GitHub App auth is not configured")

        app_jwt = self._build_jwt()
        headers = {
            "Authorization": f"Bearer {app_jwt}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

        # Lookup installation for this specific repo
        lookup_url = f"https://api.github.com/repos/{repo_full_name}/installation"
        r = requests.get(lookup_url, headers=headers, timeout=15)
        if r.status_code >= 400:
            raise GitHubAppAuthError(
                f"Docs Push App is not installed on {repo_full_name} "
                f"(HTTP {r.status_code}). Install it at https://github.com/settings/apps"
            )
        installation_id = r.json().get("id")
        if not installation_id:
            raise GitHubAppAuthError(f"Could not resolve installation ID for {repo_full_name}")

        return self.get_installation_token(int(installation_id))


    def _build_jwt(self) -> str:
        now = int(time.time())
        payload = {
            "iat": now - 60,
            "exp": now + 600,
            "iss": self.app_id,
        }
        key = self._normalize_key(self.private_key)
        try:
            encoded = jwt.encode(payload, key, algorithm="RS256")
            return encoded if isinstance(encoded, str) else encoded.decode("utf-8")
        except Exception as exc:
            raise GitHubAppAuthError(
                f"Failed to build GitHub App JWT — check GITHUB_PRIVATE_KEY format: {exc}"
            ) from exc

    @staticmethod
    def _normalize_key(raw: str) -> str:
        """
        Normalise a PEM private key that may have been pasted into an env var
        with literal \\n instead of real newlines, or with spaces instead of newlines.
        """
        # Replace literal backslash-n with real newlines
        key = raw.replace("\\n", "\n").strip()

        # If the whole key is on one line (no newlines), try to reconstruct it
        if "\n" not in key and "-----" in key:
            # Split on the PEM header/footer markers
            key = key.replace("-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\n")
            key = key.replace("-----END RSA PRIVATE KEY-----", "\n-----END RSA PRIVATE KEY-----")
            key = key.replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\n")
            key = key.replace("-----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----")

        return key
