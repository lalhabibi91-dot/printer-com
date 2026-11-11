import asyncio
import json
import os
import tempfile
from pathlib import Path

class JsonUserStore:
    """JSON account store. On Render, point DATA_FILE at a mounted persistent disk."""
    def __init__(self, path=None):
        self.path = Path(path or os.getenv("DATA_FILE", "/var/data/users.json"))
        self.lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write_sync([])

    def _read_sync(self):
        try:
            with self.path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except FileNotFoundError:
            return []

    def _write_sync(self, users):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="users-", suffix=".json", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(users, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    async def list_users(self):
        async with self.lock:
            return self._read_sync()

    async def get_user(self, username):
        async with self.lock:
            target = str(username).lower()
            for user in self._read_sync():
                if str(user.get("username", "")).lower() == target:
                    return dict(user)
            return None

    async def create_user(self, data):
        async with self.lock:
            users = self._read_sync()
            if any(str(u.get("username", "")).lower() == data["username"].lower() for u in users):
                raise ValueError("Username already exists")
            new_user = dict(data)
            new_user["id"] = str(max([int(u.get("id", 0)) for u in users if str(u.get("id", "")).isdigit()] or [0]) + 1)
            users.append(new_user)
            self._write_sync(users)
            return dict(new_user)

    async def update_user(self, username, changes):
        async with self.lock:
            users = self._read_sync()
            for i, user in enumerate(users):
                if str(user.get("username", "")).lower() == str(username).lower():
                    users[i] = {**user, **changes}
                    self._write_sync(users)
                    return dict(users[i])
            raise ValueError("User not found")

    async def delete_user(self, username):
        async with self.lock:
            users = self._read_sync()
            for i, user in enumerate(users):
                if str(user.get("username", "")).lower() == str(username).lower():
                    removed = users.pop(i)
                    self._write_sync(users)
                    return dict(removed)
            raise ValueError("User not found")
