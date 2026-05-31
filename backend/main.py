import os
import re
import json
import shutil
import subprocess
import asyncio
from typing import Dict, Optional
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import docker
import docker.errors

from database import init_db, get_db, Deployment, SessionLocal, User, UserProfile
from auth import get_current_user, hash_password, verify_password, create_access_token, SECRET_KEY, ALGORITHM, AUTH_MODE, security
import jwt

app = FastAPI(title="Mini-Heroku Orchestration API")

# Add CORS Middleware to support development testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Real-time build logs store: app_name -> list of string log lines
build_logs: Dict[str, list] = {}

class LogBroadcaster:
    def __init__(self):
        self.listeners: Dict[str, set] = {}

    def register(self, app_name: str) -> asyncio.Queue:
        if app_name not in self.listeners:
            self.listeners[app_name] = set()
        q = asyncio.Queue()
        self.listeners[app_name].add(q)
        return q

    def unregister(self, app_name: str, q: asyncio.Queue):
        if app_name in self.listeners:
            self.listeners[app_name].discard(q)
            if not self.listeners[app_name]:
                del self.listeners[app_name]

    def broadcast(self, app_name: str, message: str):
        if app_name in self.listeners:
            for q in self.listeners[app_name]:
                q.put_nowait(message)

broadcaster = LogBroadcaster()

def log_message(app_name: str, message: str):
    if app_name not in build_logs:
        build_logs[app_name] = []
    # Strip carriage returns and double newlines
    clean_msg = message.strip()
    if clean_msg:
        build_logs[app_name].append(clean_msg)
        print(f"[{app_name}] {clean_msg}", flush=True)
        broadcaster.broadcast(app_name, clean_msg)

def deploy_app_task(
    db_id: int, 
    app_name: str, 
    git_url: str, 
    port: int, 
    cpu_limit: Optional[float], 
    memory_limit: Optional[str], 
    env_vars_dict: dict
):
    db = SessionLocal()
    deployment = db.query(Deployment).filter(Deployment.id == db_id).first()
    if not deployment:
        db.close()
        return

    build_logs[app_name] = []
    log_message(app_name, f"--- Starting deployment for {app_name} ---")
    clone_dir = f"/app/clones/{app_name}"

    if os.path.exists(clone_dir):
        shutil.rmtree(clone_dir)

    try:
        # 1. Clone Github Repository
        log_message(app_name, f"Cloning repository: {git_url}...")
        result = subprocess.run(
            ["git", "clone", git_url, clone_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120
        )
        if result.stdout:
            for line in result.stdout.splitlines():
                log_message(app_name, line)
        
        if result.returncode != 0:
            raise Exception(f"Git clone failed with code {result.returncode}")

        # 2. Check for Dockerfile
        dockerfile_path = os.path.join(clone_dir, "Dockerfile")
        if not os.path.exists(dockerfile_path):
            raise Exception("No Dockerfile found in root of repository. Dockerfile is required.")

        # 3. Docker build
        log_message(app_name, "Dockerfile found. Starting BuildKit Docker image build...")
        client = docker.from_env()

        # Connect network check
        try:
            client.networks.get("mini-heroku-net")
        except docker.errors.NotFound:
            client.networks.create("mini-heroku-net", driver="bridge")

        # Use Docker CLI subprocess to run build with BuildKit enabled, supporting platform-specific variables
        build_env = os.environ.copy()
        build_env["DOCKER_BUILDKIT"] = "1"
        
        process = subprocess.Popen(
            ["docker", "build", "-t", app_name, "."],
            cwd=clone_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=build_env
        )

        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break
            if line:
                log_message(app_name, line)

        return_code = process.wait()
        if return_code != 0:
            raise Exception(f"Docker build failed with exit code {return_code}")

        # 4. Stop & remove existing container if it exists
        try:
            old_container = client.containers.get(app_name)
            log_message(app_name, f"Stopping and removing old container for {app_name}...")
            old_container.stop(timeout=5)
            old_container.remove()
        except docker.errors.NotFound:
            pass

        # 5. Launch Container with Traefik tags
        log_message(app_name, "Docker build completed. Launching container...")

        # Traefik router/service identifiers in label keys must be strictly alphanumeric
        route_name = re.sub(r'[^a-zA-Z0-9]', '', app_name)

        labels = {
            "traefik.enable": "true",
            "traefik.docker.network": "mini-heroku-net",
            f"traefik.http.routers.{route_name}.rule": f'Host("{app_name}.localhost")',
            f"traefik.http.routers.{route_name}.entrypoints": "web",
            f"traefik.http.services.{route_name}.loadbalancer.server.port": str(port)
        }

        # Convert float CPU to nano_cpus
        nano_cpus = int(cpu_limit * 1e9) if cpu_limit else None

        container = client.containers.run(
            image=app_name,
            name=app_name,
            detach=True,
            network="mini-heroku-net",
            labels=labels,
            environment=env_vars_dict,
            nano_cpus=nano_cpus,
            mem_limit=memory_limit if memory_limit else None,
            restart_policy={"Name": "on-failure"}
        )

        log_message(app_name, f"Successfully deployed! Container ID: {container.short_id}")
        log_message(app_name, f"Application route is active: http://{app_name}.localhost")

        deployment.status = "running"
        deployment.container_id = container.id
        db.commit()

    except Exception as e:
        log_message(app_name, f"Deployment ERROR: {str(e)}")
        deployment.status = "failed"
        db.commit()
    finally:
        # Clean up temporary Git clone directory
        if os.path.exists(clone_dir):
            try:
                shutil.rmtree(clone_dir)
            except Exception as cleanup_err:
                log_message(app_name, f"Warning (Cleanup): {str(cleanup_err)}")
        db.close()

# Pydantic schemas
from pydantic import BaseModel

class UserRegister(BaseModel):
    username: str
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class DeployRequest(BaseModel):
    app_name: str
    git_url: str
    port: int = 80
    cpu_limit: Optional[float] = None
    memory_limit: Optional[str] = None
    env_vars: Optional[Dict[str, str]] = None

class ProfileCreate(BaseModel):
    name: str
    use_case: str
    company: Optional[str] = None

@app.on_event("startup")
def startup_event():
    init_db()
    # Create the docker network on startup if it doesn't exist
    try:
        client = docker.from_env()
        try:
            client.networks.get("mini-heroku-net")
            print("Docker network 'mini-heroku-net' connected.")
        except docker.errors.NotFound:
            client.networks.create("mini-heroku-net", driver="bridge")
            print("Created Docker network 'mini-heroku-net'")
    except Exception as e:
        print(f"Warning: could not initialize Docker network: {e}")

# Authentication API Endpoints
@app.get("/api/auth/config")
def get_auth_config():
    return {
        "auth_mode": AUTH_MODE,
        "supabase_config": {
            "supabaseUrl": os.getenv("SUPABASE_URL"),
            "supabaseAnonKey": os.getenv("SUPABASE_ANON_KEY")
        } if AUTH_MODE == "supabase" else None
    }

@app.get("/api/auth/exists")
def check_user_exists(username: str, db: Session = Depends(get_db)):
    if AUTH_MODE == "local":
        user_exists = db.query(User).filter(User.username == username).first() is not None
        return {"exists": user_exists}
    else:
        email = username
        if "@" not in email:
            email = f"{username}@miniheroku.local"
        try:
            from sqlalchemy import text
            result = db.execute(text("SELECT 1 FROM auth.users WHERE email = :email"), {"email": email}).first()
            return {"exists": result is not None}
        except Exception as e:
            print(f"Warning: Failed to query auth.users directly: {e}. Falling back to UserProfile check.")
            profile_exists = db.query(UserProfile).filter(
                (UserProfile.email == email) | (UserProfile.id == username)
            ).first() is not None
            return {"exists": profile_exists}


@app.get("/api/auth/profile")
def get_profile(db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    profile = db.query(UserProfile).filter(UserProfile.id == current_uid).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {
        "name": profile.name,
        "use_case": profile.use_case,
        "company": profile.company,
        "email": profile.email
    }

@app.post("/api/auth/profile")
def create_profile(
    request: ProfileCreate, 
    db: Session = Depends(get_db), 
    credentials: HTTPAuthorizationCredentials = Depends(security),
    current_uid: str = Depends(get_current_user)
):
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
        existing.use_case = request.use_case
        existing.company = request.company
    else:
        profile = UserProfile(
            id=current_uid,
            email=email,
            name=request.name,
            use_case=request.use_case,
            company=request.company
        )
        db.add(profile)
    db.commit()
    return {"status": "success", "message": "Profile updated successfully"}

@app.post("/api/auth/register")
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

@app.post("/api/auth/login")
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

@app.get("/api/diagnose")
def get_diagnose(current_uid: str = Depends(get_current_user)):
    try:
        client = docker.from_env()
        networks = [
            {"name": net.name, "id": net.id, "driver": net.attrs.get("Driver")} 
            for net in client.networks.list()
        ]
        containers = []
        for c in client.containers.list():
            containers.append({
                "name": c.name,
                "status": c.status,
                "networks": list(c.attrs['NetworkSettings']['Networks'].keys()),
                "labels": {k: v for k, v in c.labels.items() if 'traefik' in k}
            })
        return {
            "networks": networks,
            "containers": containers
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/traefik-logs")
def get_traefik_logs(current_uid: str = Depends(get_current_user)):
    try:
        client = docker.from_env()
        traefik = client.containers.get("mini-heroku-traefik")
        return {"logs": traefik.logs(tail=200).decode("utf-8", errors="ignore")}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/apps")
def list_apps(db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    # Automatically claim any ownerless deployments to maintain compatibility
    unowned_deployments = db.query(Deployment).filter(Deployment.user_id == None).all()
    if unowned_deployments:
        for d in unowned_deployments:
            d.user_id = current_uid
        db.commit()

    deployments = db.query(Deployment).filter(Deployment.user_id == current_uid).all()
    result = []
    for d in deployments:
        # Verify status against actual Docker container status if status is running
        actual_status = d.status
        if d.status == "running" and d.container_id:
            try:
                client = docker.from_env()
                container = client.containers.get(d.app_name)
                if container.status != "running":
                    actual_status = "stopped"
            except docker.errors.NotFound:
                actual_status = "stopped"
            except Exception:
                pass
        
        result.append({
            "id": d.id,
            "app_name": d.app_name,
            "git_url": d.git_url,
            "local_domain": d.local_domain,
            "port": d.port,
            "status": actual_status,
            "cpu_limit": d.cpu_limit,
            "memory_limit": d.memory_limit,
            "env_vars": json.loads(d.env_vars) if d.env_vars else {},
            "created_at": d.created_at.isoformat()
        })
    return result

@app.post("/api/deploy")
def deploy_app(
    request: DeployRequest, 
    background_tasks: BackgroundTasks, 
    db: Session = Depends(get_db),
    current_uid: str = Depends(get_current_user)
):
    if not re.match("^[a-zA-Z0-9-]+$", request.app_name):
        raise HTTPException(
            status_code=400, 
            detail="App name must contain only alphanumeric characters and hyphens."
        )
    
    app_name = request.app_name.lower().strip()
    
    # Check if app name exists
    existing = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if existing:
        # Check ownership
        if existing.user_id is not None and existing.user_id != current_uid:
            raise HTTPException(
                status_code=403,
                detail="Application name already taken by another user."
            )
        
        # Trigger re-deployment
        existing.git_url = request.git_url
        existing.port = request.port
        existing.cpu_limit = request.cpu_limit
        existing.memory_limit = request.memory_limit
        existing.env_vars = json.dumps(request.env_vars) if request.env_vars else "{}"
        existing.status = "building"
        existing.user_id = current_uid  # Claim ownership if it was None
        db.commit()
        db_id = existing.id
    else:
        # Create deployment record
        deployment = Deployment(
            app_name=app_name,
            git_url=request.git_url,
            local_domain=f"http://{app_name}.localhost",
            port=request.port,
            status="building",
            cpu_limit=request.cpu_limit,
            memory_limit=request.memory_limit,
            env_vars=json.dumps(request.env_vars) if request.env_vars else "{}",
            user_id=current_uid
        )
        db.add(deployment)
        db.commit()
        db.refresh(deployment)
        db_id = deployment.id

    background_tasks.add_task(
        deploy_app_task,
        db_id=db_id,
        app_name=app_name,
        git_url=request.git_url,
        port=request.port,
        cpu_limit=request.cpu_limit,
        memory_limit=request.memory_limit,
        env_vars_dict=request.env_vars or {}
    )

    return {
        "status": "success",
        "message": f"Deployment and build started for '{app_name}'",
        "app_name": app_name,
        "local_domain": f"http://{app_name}.localhost"
    }

@app.post("/api/apps/{app_name}/start")
def start_app(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    
    if deployment.user_id is not None and deployment.user_id != current_uid:
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = docker.from_env()
        container = client.containers.get(app_name)
        container.start()
        deployment.status = "running"
        db.commit()
        log_message(app_name, "Application container started manually.")
        return {"status": "success", "message": f"App {app_name} started"}
    except docker.errors.NotFound:
        raise HTTPException(status_code=400, detail="Container not found. Please trigger deployment again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apps/{app_name}/stop")
def stop_app(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    
    if deployment.user_id is not None and deployment.user_id != current_uid:
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = docker.from_env()
        container = client.containers.get(app_name)
        container.stop(timeout=5)
        deployment.status = "stopped"
        db.commit()
        log_message(app_name, "Application container stopped manually.")
        return {"status": "success", "message": f"App {app_name} stopped"}
    except docker.errors.NotFound:
        deployment.status = "stopped"
        db.commit()
        return {"status": "success", "message": f"Container not found, marked as stopped"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apps/{app_name}/restart")
def restart_app(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    
    if deployment.user_id is not None and deployment.user_id != current_uid:
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = docker.from_env()
        container = client.containers.get(app_name)
        container.restart()
        deployment.status = "running"
        db.commit()
        log_message(app_name, "Application container restarted manually.")
        return {"status": "success", "message": f"App {app_name} restarted"}
    except docker.errors.NotFound:
        raise HTTPException(status_code=400, detail="Container not found. Please trigger deployment again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apps/{app_name}/delete")
def delete_app(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    
    if deployment.user_id is not None and deployment.user_id != current_uid:
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = docker.from_env()
        try:
            container = client.containers.get(app_name)
            container.stop(timeout=5)
            container.remove()
        except docker.errors.NotFound:
            pass
        
        try:
            client.images.remove(image=app_name, force=True)
        except Exception:
            pass

        db.delete(deployment)
        db.commit()
        
        if app_name in build_logs:
            del build_logs[app_name]
            
        return {"status": "success", "message": f"App {app_name} deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/apps/{app_name}/stats")
def get_app_stats(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")

    if deployment.user_id is not None and deployment.user_id != current_uid:
        raise HTTPException(status_code=403, detail="Permission denied")

    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    if deployment.status != "running":
        return {
            "status": deployment.status, 
            "cpu_percent": 0.0, 
            "memory_usage_mb": 0.0, 
            "memory_limit_mb": 0.0, 
            "memory_percent": 0.0
        }

    try:
        client = docker.from_env()
        container = client.containers.get(app_name)
        
        # Non-streaming statistics query
        stats = container.stats(stream=False)
        
        # Calculate CPU usage
        cpu_stats = stats.get('cpu_stats', {})
        precpu_stats = stats.get('precpu_stats', {})
        
        cpu_percent = 0.0
        cpu_usage = cpu_stats.get('cpu_usage', {}).get('total_usage', 0)
        precpu_usage = precpu_stats.get('cpu_usage', {}).get('total_usage', 0)
        
        system_cpu = cpu_stats.get('system_cpu_usage', 0)
        presystem_cpu = precpu_stats.get('system_cpu_usage', 0)
        
        cpu_delta = cpu_usage - precpu_usage
        system_delta = system_cpu - presystem_cpu
        
        online_cpus = cpu_stats.get('online_cpus', 1)
        
        if system_delta > 0 and cpu_delta > 0:
            # Formula matching docker stats CLI
            cpu_percent = (cpu_delta / system_delta) * online_cpus * 100.0
            
        # Calculate Memory Usage
        memory_stats = stats.get('memory_stats', {})
        mem_usage = memory_stats.get('usage', 0)
        mem_limit = memory_stats.get('limit', 1)
        
        mem_usage_mb = round(mem_usage / (1024 * 1024), 2)
        mem_limit_mb = round(mem_limit / (1024 * 1024), 2)
        mem_percent = round((mem_usage / mem_limit) * 100.0, 2)
        cpu_percent = round(cpu_percent, 2)
        
        return {
            "status": "running",
            "cpu_percent": cpu_percent,
            "memory_usage_mb": mem_usage_mb,
            "memory_limit_mb": mem_limit_mb,
            "memory_percent": mem_percent
        }
    except docker.errors.NotFound:
        # Sync DB state
        deployment.status = "stopped"
        db.commit()
        return {
            "status": "stopped", 
            "cpu_percent": 0.0, 
            "memory_usage_mb": 0.0, 
            "memory_limit_mb": 0.0, 
            "memory_percent": 0.0
        }
    except Exception as e:
        return {
            "status": "error", 
            "message": str(e), 
            "cpu_percent": 0.0, 
            "memory_usage_mb": 0.0, 
            "memory_limit_mb": 0.0, 
            "memory_percent": 0.0
        }

@app.websocket("/ws/logs/{app_name}")
async def websocket_logs(websocket: WebSocket, app_name: str, token: Optional[str] = None):
    await websocket.accept()

    if not token:
        try:
            await websocket.send_text("[UI-CLIENT] Authentication token missing.")
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    uid = None
    if AUTH_MODE == "local":
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            username: str = payload.get("sub")
            if username:
                db = SessionLocal()
                user = db.query(User).filter(User.username == username).first()
                if user:
                    uid = str(user.id)
                db.close()
        except jwt.PyJWTError:
            pass
    else:
        try:
            from auth import verify_supabase_token
            decoded_token = verify_supabase_token(token)
            uid = decoded_token.get("sub")
        except Exception as e:
            print(f"WS authentication error: {e}", flush=True)
            pass

    if not uid:
        try:
            await websocket.send_text("[UI-CLIENT] Invalid or expired authentication token.")
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    db = SessionLocal()
    try:
        deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
        if not deployment:
            await websocket.send_text("[UI-CLIENT] Application not found.")
            await websocket.close(code=1008)
            return

        if deployment.user_id is not None and deployment.user_id != uid:
            await websocket.send_text("[UI-CLIENT] Access denied.")
            await websocket.close(code=1008)
            return

        # Claim ownerless deployment
        if deployment.user_id is None:
            deployment.user_id = uid
            db.commit()
    except Exception as err:
        try:
            await websocket.send_text(f"[UI-CLIENT] Server error during authorization: {err}")
            await websocket.close(code=1008)
        except Exception:
            pass
        return
    finally:
        db.close()
    
    # Stream historical build logs
    logs = build_logs.get(app_name, [])
    for line in logs:
        try:
            await websocket.send_text(line)
        except Exception:
            return

    # Stream running container logs as fallback if build log is empty and app is running
    if not logs:
        try:
            client = docker.from_env()
            container = client.containers.get(app_name)
            # Retrieve last 50 lines
            logs_content = container.logs(tail=50, stdout=True, stderr=True).decode('utf-8', errors='ignore')
            for line in logs_content.splitlines():
                await websocket.send_text(f"[container] {line}")
        except Exception:
            pass

    # Wait for new log broadcasts in queue
    q = broadcaster.register(app_name)
    try:
        while True:
            message = await q.get()
            await websocket.send_text(message)
    except Exception:
        pass
    finally:
        broadcaster.unregister(app_name, q)

# Mount frontend files (served at app root)
frontend_path = "/app/frontend"
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:
    # Local dev fallback
    local_frontend = os.path.join(os.path.dirname(__file__), "../frontend")
    if os.path.exists(local_frontend):
        app.mount("/", StaticFiles(directory=local_frontend, html=True), name="frontend")
