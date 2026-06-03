import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, Text, DateTime, ForeignKey, text, inspect, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

from urllib.parse import quote_plus, unquote

def sanitize_database_url(url: str) -> str:
    if not url:
        return url
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    if url.startswith("sqlite"):
        return url
    try:
        if "://" in url:
            scheme, rest = url.split("://", 1)
            if "@" in rest:
                credentials, host_part = rest.rsplit("@", 1)
                if ":" in credentials:
                    username, password = credentials.split(":", 1)
                    escaped_password = quote_plus(unquote(password))
                    credentials = f"{username}:{escaped_password}"
                host_part = host_part.replace("[", "").replace("]", "")
                url = f"{scheme}://{credentials}@{host_part}"
    except Exception as e:
        print(f"Warning: Failed to sanitize database URL: {e}")
    return url

DATABASE_URL = sanitize_database_url(os.getenv("DATABASE_URL", "sqlite:///./data/mini_heroku.db"))

# Create parent directories for sqlite db if they don't exist
if DATABASE_URL.startswith("sqlite"):
    db_dir = os.path.dirname(DATABASE_URL.replace("sqlite:///", ""))
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)

# Create engine. Check same thread only for SQLite
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserProfile(Base):
    __tablename__ = "user_profiles"

    id = Column(String, primary_key=True, index=True) # Supabase UID or local user ID
    email = Column(String, nullable=False)
    name = Column(String, nullable=False)
    username = Column(String, unique=True, nullable=True)
    use_case = Column(String, nullable=False)
    company = Column(String, nullable=True)
    save_history = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class Deployment(Base):
    __tablename__ = "deployments"

    id = Column(Integer, primary_key=True, index=True)
    app_name = Column(String, unique=True, index=True, nullable=False)
    git_url = Column(String, nullable=False)
    local_domain = Column(String, nullable=False)
    port = Column(Integer, default=80)
    status = Column(String, default="pending")  # pending, building, running, stopped, failed
    cpu_limit = Column(Float, nullable=True)     # e.g., 0.5 for 50% CPU
    memory_limit = Column(String, nullable=True) # e.g., '512m'
    env_vars = Column(Text, nullable=True)       # Serialized JSON string of environmental variables
    container_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    user_id = Column(String, nullable=True)
    auto_deploy = Column(Boolean, default=False)
    last_commit_hash = Column(String, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class DeploymentHistory(Base):
    __tablename__ = "deployment_history"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    app_name = Column(String, nullable=False)
    git_url = Column(String, nullable=False)
    status = Column(String, nullable=False)  # success, failed
    last_commit_hash = Column(String, nullable=True)
    deployed_at = Column(DateTime, default=datetime.utcnow)

def init_db():
    Base.metadata.create_all(bind=engine)
    # Check if table deployments exists and if it has required columns
    inspector = inspect(engine)
    if 'deployments' in inspector.get_table_names():
        columns = [col['name'] for col in inspector.get_columns('deployments')]
        with engine.begin() as conn:
            if 'user_id' not in columns:
                conn.execute(text("ALTER TABLE deployments ADD COLUMN user_id TEXT"))
            if 'auto_deploy' not in columns:
                conn.execute(text("ALTER TABLE deployments ADD COLUMN auto_deploy BOOLEAN DEFAULT 0"))
            if 'last_commit_hash' not in columns:
                conn.execute(text("ALTER TABLE deployments ADD COLUMN last_commit_hash TEXT"))
            if 'updated_at' not in columns:
                # Add default current timestamp for postgres/sqlite compatible formats
                conn.execute(text("ALTER TABLE deployments ADD COLUMN updated_at TIMESTAMP"))

    # Check if table user_profiles exists and if it has save_history column
    if 'user_profiles' in inspector.get_table_names():
        columns = [col['name'] for col in inspector.get_columns('user_profiles')]
        with engine.begin() as conn:
            if 'save_history' not in columns:
                conn.execute(text("ALTER TABLE user_profiles ADD COLUMN save_history BOOLEAN DEFAULT 1"))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
