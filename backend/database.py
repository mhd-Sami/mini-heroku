import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, Text, DateTime, ForeignKey, text, inspect
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/mini_heroku.db")

# SQLAlchemy requires postgresql:// instead of postgres://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

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

    deployments = relationship("Deployment", back_populates="user", cascade="all, delete-orphan")

class UserProfile(Base):
    __tablename__ = "user_profiles"

    id = Column(String, primary_key=True, index=True) # Supabase UID or local user ID
    email = Column(String, nullable=False)
    name = Column(String, nullable=False)
    use_case = Column(String, nullable=False)
    company = Column(String, nullable=True)
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
    user_id = Column(String, ForeignKey("users.id"), nullable=True)

    user = relationship("User", back_populates="deployments")

def init_db():
    Base.metadata.create_all(bind=engine)
    # Check if table deployments exists and if it has user_id column
    inspector = inspect(engine)
    if 'deployments' in inspector.get_table_names():
        columns = [col['name'] for col in inspector.get_columns('deployments')]
        if 'user_id' not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE deployments ADD COLUMN user_id TEXT"))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
