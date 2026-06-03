import os
import sys
from sqlalchemy import text

# Ensure backend directory is in path if run from root
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database import engine

def add_database_indexes():
    print("Checking database configuration and indexes...", flush=True)
    
    # SQL queries for cross-compatible indexing (SQLite & PostgreSQL)
    queries = [
        "CREATE INDEX IF NOT EXISTS idx_deployments_user_id ON deployments(user_id);",
        "CREATE INDEX IF NOT EXISTS idx_deployment_history_app_name ON deployment_history(app_name);",
        "CREATE INDEX IF NOT EXISTS idx_user_profiles_username ON user_profiles(username);"
    ]
    
    with engine.begin() as conn:
        for query in queries:
            try:
                print(f"Executing: {query}", flush=True)
                conn.execute(text(query))
            except Exception as e:
                print(f"Warning: Index creation query failed: {e}", flush=True)
                
    print("Database indexing check completed successfully.", flush=True)

if __name__ == "__main__":
    add_database_indexes()
