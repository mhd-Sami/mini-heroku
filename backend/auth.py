import os
import secrets
import urllib.request
import json
from typing import Optional
from datetime import datetime, timedelta
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import jwt
import bcrypt

from database import get_db, User

# Read the Authentication Mode (supabase by default, local for developer fallback)
AUTH_MODE = os.getenv("MINI_HEROKU_AUTH_MODE", "supabase").lower()

# Resolve persistent JWT secret key for local auth mode fallback
SECRET_KEY = os.getenv("JWT_SECRET")
if not SECRET_KEY:
    data_dir = "/app/data"
    if not os.path.exists(data_dir):
        data_dir = os.path.join(os.path.dirname(__file__), "data")
        os.makedirs(data_dir, exist_ok=True)
    
    secret_path = os.path.join(data_dir, "jwt_secret")
    if os.path.exists(secret_path):
        try:
            with open(secret_path, "r", encoding="utf-8") as f:
                SECRET_KEY = f.read().strip()
        except Exception as e:
            print(f"Warning: Failed to read persistent JWT secret from {secret_path}: {e}")

    if not SECRET_KEY:
        SECRET_KEY = secrets.token_hex(32)
        try:
            with open(secret_path, "w", encoding="utf-8") as f:
                f.write(SECRET_KEY)
            print(f"Generated and persisted new secure JWT secret key to {secret_path}")
        except Exception as e:
            print(f"Warning: Failed to save persistent JWT secret to {secret_path}: {e}")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

security = HTTPBearer()

jwk_client = None

def verify_supabase_token(token: str) -> dict:
    global jwk_client
    
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")
    except Exception as e:
        raise Exception(f"Failed to parse JWT header: {e}")
        
    if alg == "HS256":
        jwt_secret = os.getenv("SUPABASE_JWT_SECRET")
        if not jwt_secret:
            raise Exception("SUPABASE_JWT_SECRET environment variable is not configured on the backend.")
        decoded = jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False}
        )
        return decoded
        
    elif alg == "ES256":
        supabase_url = os.getenv("SUPABASE_URL")
        if not supabase_url:
            raise Exception("SUPABASE_URL environment variable is not configured on the backend.")
            
        supabase_url = supabase_url.rstrip("/")
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        
        if jwk_client is None:
            from jwt import PyJWKClient
            jwk_client = PyJWKClient(jwks_url)
            
        signing_key = jwk_client.get_signing_key_from_jwt(token)
        
        decoded = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            options={"verify_aud": False}
        )
        return decoded
    else:
        raise Exception(f"Unsupported JWT signing algorithm: {alg}")



def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed_password.encode('utf-8'))
    except Exception:
        return False

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security), db: Session = Depends(get_db)) -> str:
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    if AUTH_MODE == "local":
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            username: str = payload.get("sub")
            if username is None:
                raise credentials_exception
        except jwt.PyJWTError:
            raise credentials_exception
        
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            raise credentials_exception
        return str(user.id)
    else:
        try:
            decoded_token = verify_supabase_token(token)
            uid = decoded_token.get("sub")
            if not uid:
                raise credentials_exception
            return uid
        except Exception as e:
            print(f"Supabase token verification failed: {e}", flush=True)
            raise credentials_exception
