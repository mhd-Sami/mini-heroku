import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, Text, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/mini_heroku.db")

# Create parent directories for sqlite db if they don't exist
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

def init_db():
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
