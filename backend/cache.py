import time
import threading
from typing import Dict, Any, Optional

class MemoryCache:
    def __init__(self):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        """Retrieve a value from the cache if it exists and is not expired."""
        with self._lock:
            item = self._cache.get(key)
            if item:
                if item["expires_at"] > time.time():
                    return item["value"]
                else:
                    # Expired, clean it up
                    del self._cache[key]
            return None

    def set(self, key: str, value: Any, ttl: float = 30.0):
        """Set a value in the cache with a Time-To-Live (TTL) in seconds."""
        with self._lock:
            self._cache[key] = {
                "value": value,
                "expires_at": time.time() + ttl
            }

    def delete(self, key: str):
        """Remove a specific key from the cache."""
        with self._lock:
            self._cache.pop(key, None)

    def clear(self):
        """Clear all entries from the cache."""
        with self._lock:
            self._cache.clear()

# Global thread-safe cache instance
global_cache = MemoryCache()
