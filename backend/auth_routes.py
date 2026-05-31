import os
import re
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
import jwt

from database import get_db, User, UserProfile
from auth import (
    get_current_user,
    hash_password,
    verify_password,
    create_access_token,
    SECRET_KEY,
    ALGORITHM,
    AUTH_MODE,
    security
)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

# Pydantic schemas
class UserRegister(BaseModel):
    username: str
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class ProfileCreate(BaseModel):
    name: str
    use_case: str
    username: str
    company: Optional[str] = None

class PasswordUpdate(BaseModel):
    password: str

@router.get("/config")
def get_auth_config():
    return {
        "auth_mode": AUTH_MODE,
        "supabase_config": {
            "supabaseUrl": os.getenv("SUPABASE_URL"),
            "supabaseAnonKey": os.getenv("SUPABASE_ANON_KEY")
        } if AUTH_MODE == "supabase" else None
    }

@router.get("/exists")
def check_user_exists(username: str, db: Session = Depends(get_db)):
    if AUTH_MODE == "local":
        user_exists = db.query(User).filter(User.username == username).first() is not None
        return {"exists": user_exists}
    else:
        if "@" in username:
            email = username
            try:
                from sqlalchemy import text
                result = db.execute(text("SELECT 1 FROM auth.users WHERE email = :email"), {"email": email}).first()
                return {"exists": result is not None}
            except Exception as e:
                print(f"Warning: Failed to query auth.users directly: {e}. Falling back to UserProfile check.")
                profile_exists = db.query(UserProfile).filter(UserProfile.email == email).first() is not None
                return {"exists": profile_exists}
        else:
            # Check custom username uniqueness in UserProfile
            username_taken = db.query(UserProfile).filter(UserProfile.username == username).first() is not None
            return {"exists": username_taken}

@router.get("/resolve")
def resolve_username(username: str, db: Session = Depends(get_db)):
    if "@" in username:
        return {"email": username}
    
    profile = db.query(UserProfile).filter(UserProfile.username == username).first()
    if not profile:
        raise HTTPException(status_code=404, detail="No account exists with this username.")
    return {"email": profile.email}

@router.get("/profile")
def get_profile(db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    profile = db.query(UserProfile).filter(UserProfile.id == current_uid).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {
        "name": profile.name,
        "use_case": profile.use_case,
        "company": profile.company,
        "email": profile.email,
        "username": profile.username
    }

@router.post("/profile")
def create_profile(
    request: ProfileCreate, 
    db: Session = Depends(get_db), 
    credentials: HTTPAuthorizationCredentials = Depends(security),
    current_uid: str = Depends(get_current_user)
):
    # Validate username format
    if not re.match("^[a-zA-Z0-9_-]{3,20}$", request.username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 characters long and contain only alphanumeric characters, underscores, or hyphens."
        )

    # Check if username is already taken by another user
    username_taken = db.query(UserProfile).filter(
        UserProfile.username == request.username,
        UserProfile.id != current_uid
    ).first() is not None
    if username_taken:
        raise HTTPException(
            status_code=400,
            detail="Username already taken."
        )

    email = "unknown@miniheroku.local"
    if AUTH_MODE == "local":
        user = db.query(User).filter(User.id == int(current_uid)).first()
        if user:
            email = user.username
    else:
        try:
            token = credentials.credentials
            decoded = jwt.decode(token, options={"verify_signature": False})
            email = decoded.get("email") or "unknown@miniheroku.local"
        except Exception as e:
            print(f"Error reading email from verified token: {e}", flush=True)
            pass

    existing = db.query(UserProfile).filter(UserProfile.id == current_uid).first()
    if existing:
        existing.name = request.name
        existing.username = request.username
        existing.use_case = request.use_case
        existing.company = request.company
    else:
        profile = UserProfile(
            id=current_uid,
            email=email,
            name=request.name,
            username=request.username,
            use_case=request.use_case,
            company=request.company
        )
        db.add(profile)
    db.commit()
    return {"status": "success", "message": "Profile updated successfully"}

@router.post("/register")
def register(request: UserRegister, db: Session = Depends(get_db)):
    if AUTH_MODE != "local":
        raise HTTPException(
            status_code=400,
            detail="Local registration is disabled in Supabase environment."
        )
    if not re.match("^[a-zA-Z0-9_-]{3,20}$", request.username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 characters long and contain only alphanumeric characters, underscores, or hyphens."
        )
    if len(request.password) < 6:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 6 characters long."
        )
    
    existing = db.query(User).filter(User.username == request.username).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail="Username already taken."
        )
    
    hashed = hash_password(request.password)
    user = User(username=request.username, hashed_password=hashed)
    db.add(user)
    db.commit()
    return {"status": "success", "message": "User registered successfully"}

@router.post("/login")
def login(request: UserLogin, db: Session = Depends(get_db)):
    if AUTH_MODE != "local":
        raise HTTPException(
            status_code=400,
            detail="Local login is disabled in Supabase environment."
        )
    user = db.query(User).filter(User.username == request.username).first()
    if not user:
        raise HTTPException(
            status_code=404,
            detail="No account exists"
        )
    if not verify_password(request.password, user.hashed_password):
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password"
        )
    
    access_token = create_access_token(data={"sub": user.username})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user.username
    }

@router.post("/change-password")
def change_password(
    request: PasswordUpdate,
    db: Session = Depends(get_db),
    current_uid: str = Depends(get_current_user)
):
    if AUTH_MODE != "local":
        raise HTTPException(
            status_code=400,
            detail="Password updates via API are disabled in Supabase environment."
        )
    if len(request.password) < 6:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 6 characters long."
        )
    user = db.query(User).filter(User.id == int(current_uid)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    user.hashed_password = hash_password(request.password)
    db.commit()
    return {"status": "success", "message": "Password updated successfully"}
