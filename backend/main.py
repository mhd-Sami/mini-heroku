import os
from datetime import datetime
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

from database import init_db, get_db, Deployment, SessionLocal, User, UserProfile, DeploymentHistory
from auth import get_current_user, hash_password, verify_password, create_access_token, SECRET_KEY, ALGORITHM, AUTH_MODE, security
import jwt
from auth_routes import router as auth_router

_docker_client = None

def get_docker_client():
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client

def heal_container_network(client, container):
    try:
        container.reload()
        current_networks = container.attrs.get('NetworkSettings', {}).get('Networks', {})
        try:
            target_net = client.networks.get("mini-heroku-net")
        except docker.errors.NotFound:
            target_net = client.networks.create("mini-heroku-net", driver="bridge")
            
        connected = False
        for net_name, net_info in current_networks.items():
            if net_name == "mini-heroku-net":
                try:
                    actual_net = client.networks.get(net_info.get("NetworkID"))
                    if actual_net.id == target_net.id:
                        connected = True
                except Exception:
                    pass
        
        if not connected:
            print(f"Healing network connection for container {container.name}", flush=True)
            for net_name in list(current_networks.keys()):
                try:
                    client.networks.get(net_name).disconnect(container, force=True)
                except Exception:
                    pass
            target_net.connect(container)
            container.reload()
    except Exception as e:
        print(f"Warning: Failed to heal network for container {container.name}: {e}", flush=True)

app = FastAPI(title="Mini-Heroku Orchestration API")
app.include_router(auth_router)

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

def get_remote_commit_hash(git_url: str) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "ls-remote", git_url, "HEAD"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15
        )
        if result.returncode == 0 and result.stdout:
            parts = result.stdout.split()
            if parts:
                return parts[0]
    except Exception as e:
        print(f"Error fetching remote commit hash: {e}", flush=True)
    return None

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
        client = get_docker_client()

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
        deployment.updated_at = datetime.utcnow()

        # Get commit hash of what was built
        try:
            hash_result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=clone_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10
            )
            if hash_result.returncode == 0 and hash_result.stdout:
                deployment.last_commit_hash = hash_result.stdout.strip()
                log_message(app_name, f"Cached last deployed commit hash: {deployment.last_commit_hash}")
        except Exception as hash_err:
            log_message(app_name, f"Warning: Could not fetch build commit hash: {hash_err}")

        db.commit()

        # Save history if enabled
        if deployment.user_id:
            try:
                profile = db.query(UserProfile).filter(UserProfile.id == deployment.user_id).first()
                if not profile or getattr(profile, "save_history", True):
                    history_entry = DeploymentHistory(
                        user_id=deployment.user_id,
                        app_name=app_name,
                        git_url=git_url,
                        status="success",
                        last_commit_hash=deployment.last_commit_hash
                    )
                    db.add(history_entry)
                    db.commit()
            except Exception as hist_err:
                print(f"Error logging success deployment history: {hist_err}", flush=True)

    except Exception as e:
        log_message(app_name, f"Deployment ERROR: {str(e)}")
        deployment.status = "failed"
        deployment.updated_at = datetime.utcnow()
        db.commit()

        # Save history if enabled
        if deployment.user_id:
            try:
                profile = db.query(UserProfile).filter(UserProfile.id == deployment.user_id).first()
                if not profile or getattr(profile, "save_history", True):
                    history_entry = DeploymentHistory(
                        user_id=deployment.user_id,
                        app_name=app_name,
                        git_url=git_url,
                        status="failed",
                        last_commit_hash=deployment.last_commit_hash
                    )
                    db.add(history_entry)
                    db.commit()
            except Exception as hist_err:
                print(f"Error logging failed deployment history: {hist_err}", flush=True)
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

class DeploymentHistoryResponse(BaseModel):
    id: int
    app_name: str
    git_url: str
    status: str
    last_commit_hash: Optional[str] = None
    deployed_at: datetime

    class Config:
        orm_mode = True

class DeployRequest(BaseModel):
    app_name: str
    git_url: str
    port: int = 80
    cpu_limit: Optional[float] = None
    memory_limit: Optional[str] = None
    env_vars: Optional[Dict[str, str]] = None
    auto_deploy: Optional[bool] = False

@app.on_event("startup")
def startup_event():
    init_db()
    # Create the docker network on startup if it doesn't exist
    try:
        client = get_docker_client()
        try:
            client.networks.get("mini-heroku-net")
            print("Docker network 'mini-heroku-net' connected.")
        except docker.errors.NotFound:
            client.networks.create("mini-heroku-net", driver="bridge")
            print("Created Docker network 'mini-heroku-net'")
    except Exception as e:
        print(f"Warning: could not initialize Docker network: {e}")

    # Start auto-deploy background poller loop
    asyncio.create_task(auto_deploy_poller())
    # Start live telemetry stats cacher background task
    asyncio.create_task(stats_cacher_loop())

_app_stats_cache = {}

def fetch_and_cache_single_app_stats(app_name: str, user_id: str):
    global _app_stats_cache
    try:
        client = get_docker_client()
        container = client.containers.get(app_name)
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
            cpu_percent = (cpu_delta / system_delta) * online_cpus * 100.0
            
        # Calculate Memory Usage
        memory_stats = stats.get('memory_stats', {})
        mem_usage = memory_stats.get('usage', 0)
        mem_limit = memory_stats.get('limit', 1)
        
        mem_usage_mb = round(mem_usage / (1024 * 1024), 2)
        mem_limit_mb = round(mem_limit / (1024 * 1024), 2)
        mem_percent = round((mem_usage / mem_limit) * 100.0, 2)
        cpu_percent = round(cpu_percent, 2)
        
        _app_stats_cache[app_name] = {
            "status": "running",
            "cpu_percent": cpu_percent,
            "memory_usage_mb": mem_usage_mb,
            "memory_limit_mb": mem_limit_mb,
            "memory_percent": mem_percent,
            "user_id": user_id
        }
    except docker.errors.NotFound:
        # Sync DB state
        try:
            db = SessionLocal()
            deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
            if deployment:
                deployment.status = "stopped"
                db.commit()
            db.close()
        except Exception:
            pass
        _app_stats_cache.pop(app_name, None)
    except Exception:
        pass

async def stats_cacher_loop():
    print("Vessel stats cacher loop background task started.", flush=True)
    while True:
        try:
            db = SessionLocal()
            running_deployments = db.query(Deployment).filter(Deployment.status == "running").all()
            db.close()
            
            if running_deployments:
                tasks = []
                for d in running_deployments:
                    tasks.append(asyncio.to_thread(fetch_and_cache_single_app_stats, d.app_name, d.user_id))
                await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            print(f"[STATS-CACHER] Error in cacher loop: {e}", flush=True)
        
        await asyncio.sleep(3)

async def auto_deploy_poller():
    print("Auto-deployment background poller task started.", flush=True)
    while True:
        await asyncio.sleep(60) # Poll every 60 seconds
        db = SessionLocal()
        try:
            apps = db.query(Deployment).filter(
                Deployment.auto_deploy == True,
                Deployment.status == "running"
            ).all()
            
            for app in apps:
                latest_hash = get_remote_commit_hash(app.git_url)
                if not latest_hash:
                    continue
                
                if app.last_commit_hash != latest_hash:
                    print(f"[AUTO-DEPLOY] New changes detected for app '{app.app_name}'. Local: {app.last_commit_hash}, Remote: {latest_hash}. Triggering rebuild...", flush=True)
                    app.status = "building"
                    app.last_commit_hash = latest_hash
                    db.commit()
                    
                    loop = asyncio.get_event_loop()
                    loop.run_in_executor(
                        None,
                        deploy_app_task,
                        app.id,
                        app.app_name,
                        app.git_url,
                        app.port,
                        app.cpu_limit,
                        app.memory_limit,
                        json.loads(app.env_vars) if app.env_vars else {}
                    )
        except Exception as e:
            print(f"[AUTO-DEPLOY] Error in poller loop: {e}", flush=True)
        finally:
            db.close()



@app.get("/api/diagnose")
def get_diagnose(current_uid: str = Depends(get_current_user)):
    try:
        client = get_docker_client()
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
        client = get_docker_client()
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
    
    # Query docker container statuses once to avoid loop-level API connections
    container_status_map = {}
    if any(d.status == "running" and d.container_id for d in deployments):
        try:
            client = get_docker_client()
            containers = client.containers.list(all=True)
            for c in containers:
                container_status_map[c.name] = c.status
        except Exception as e:
            print(f"Error listing docker containers: {e}", flush=True)

    result = []
    for d in deployments:
        # Verify status against actual Docker container status if status is running
        actual_status = d.status
        if d.status == "running" and d.container_id:
            c_status = container_status_map.get(d.app_name)
            if c_status != "running":
                actual_status = "stopped"
        
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
            "auto_deploy": d.auto_deploy,
            "last_commit_hash": d.last_commit_hash,
            "updated_at": d.updated_at.isoformat() if d.updated_at else d.created_at.isoformat(),
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
        if existing.user_id is not None and str(existing.user_id) != str(current_uid):
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
        if request.auto_deploy is not None:
            existing.auto_deploy = request.auto_deploy
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
            user_id=current_uid,
            auto_deploy=request.auto_deploy or False
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
    
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = get_docker_client()
        container = client.containers.get(app_name)
        heal_container_network(client, container)
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
    
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = get_docker_client()
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
    
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = get_docker_client()
        container = client.containers.get(app_name)
        heal_container_network(client, container)
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
    
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")
    
    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()
    
    try:
        client = get_docker_client()
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

class AutoDeployToggleRequest(BaseModel):
    enabled: bool

@app.post("/api/apps/{app_name}/auto-deploy")
def toggle_auto_deploy(
    app_name: str, 
    request: AutoDeployToggleRequest, 
    db: Session = Depends(get_db), 
    current_uid: str = Depends(get_current_user)
):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")
        
    deployment.auto_deploy = request.enabled
    
    # If enabling auto-deploy, query the remote HEAD hash immediately and cache it
    # so that we don't trigger a redeployment on the very next poll cycle
    if request.enabled and not deployment.last_commit_hash:
        commit_hash = get_remote_commit_hash(deployment.git_url)
        if commit_hash:
            deployment.last_commit_hash = commit_hash
            
    db.commit()
    return {"status": "success", "auto_deploy": deployment.auto_deploy}

@app.get("/api/apps/stats/bulk")
def get_bulk_app_stats(current_uid: str = Depends(get_current_user)):
    user_stats = {}
    for app_name, stats in _app_stats_cache.items():
        if str(stats.get("user_id")) == str(current_uid):
            user_stats[app_name] = {
                "status": stats.get("status"),
                "cpu_percent": stats.get("cpu_percent"),
                "memory_usage_mb": stats.get("memory_usage_mb"),
                "memory_limit_mb": stats.get("memory_limit_mb"),
                "memory_percent": stats.get("memory_percent")
            }
    return user_stats

@app.get("/api/apps/{app_name}/stats")
def get_app_stats(app_name: str, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")

    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")

    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()

    # Check memory cache first
    cached = _app_stats_cache.get(app_name)
    if cached:
        res = {
            "status": cached.get("status"),
            "cpu_percent": cached.get("cpu_percent"),
            "memory_usage_mb": cached.get("memory_usage_mb"),
            "memory_limit_mb": cached.get("memory_limit_mb"),
            "memory_percent": cached.get("memory_percent")
        }
    else:
        # Fallback / Default
        res = {}
        if deployment.status != "running":
            res = {
                "status": deployment.status, 
                "cpu_percent": 0.0, 
                "memory_usage_mb": 0.0, 
                "memory_limit_mb": 0.0, 
                "memory_percent": 0.0
            }
        else:
            try:
                client = get_docker_client()
                container = client.containers.get(app_name)
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
                    cpu_percent = (cpu_delta / system_delta) * online_cpus * 100.0
                    
                # Calculate Memory Usage
                memory_stats = stats.get('memory_stats', {})
                mem_usage = memory_stats.get('usage', 0)
                mem_limit = memory_stats.get('limit', 1)
                
                mem_usage_mb = round(mem_usage / (1024 * 1024), 2)
                mem_limit_mb = round(mem_limit / (1024 * 1024), 2)
                mem_percent = round((mem_usage / mem_limit) * 100.0, 2)
                cpu_percent = round(cpu_percent, 2)
                
                res = {
                    "status": "running",
                    "cpu_percent": cpu_percent,
                    "memory_usage_mb": mem_usage_mb,
                    "memory_limit_mb": mem_limit_mb,
                    "memory_percent": mem_percent
                }
                
                # Cache it
                _app_stats_cache[app_name] = {
                    **res,
                    "user_id": current_uid
                }
            except docker.errors.NotFound:
                deployment.status = "stopped"
                db.commit()
                res = {
                    "status": "stopped", 
                    "cpu_percent": 0.0, 
                    "memory_usage_mb": 0.0, 
                    "memory_limit_mb": 0.0, 
                    "memory_percent": 0.0
                }
            except Exception as e:
                res = {
                    "status": "error", 
                    "message": str(e), 
                    "cpu_percent": 0.0, 
                    "memory_usage_mb": 0.0, 
                    "memory_limit_mb": 0.0, 
                    "memory_percent": 0.0
                }
                
    # Inject database metadata fields for frontend real-time tracking
    res["updated_at"] = deployment.updated_at.isoformat() if deployment.updated_at else None
    res["auto_deploy"] = deployment.auto_deploy
    res["last_commit_hash"] = deployment.last_commit_hash
    return res

@app.get("/api/system-info")
def get_system_info(current_uid: str = Depends(get_current_user)):
    try:
        import platform
        # Check host disk space via bind mount directory, falling back to local dir if running outside Docker
        disk_path = "/app/frontend" if os.path.exists("/app/frontend") else "."
        total, used, free = shutil.disk_usage(disk_path)
        # Convert to GB
        total_gb = round(total / (1024 * 1024 * 1024), 1)
        used_gb = round(used / (1024 * 1024 * 1024), 1)
        free_gb = round(free / (1024 * 1024 * 1024), 1)
        disk_percent = round((used / total) * 100, 1) if total > 0 else 0
        
        try:
            client = get_docker_client()
            docker_version = client.version().get("Version", "Unknown") if client else "N/A"
        except Exception:
            docker_version = "Docker Host Unreachable"

        return {
            "cpu_cores": os.cpu_count() or 1,
            "platform": platform.system(),
            "disk_total_gb": total_gb,
            "disk_used_gb": used_gb,
            "disk_free_gb": free_gb,
            "disk_percent": disk_percent,
            "docker_version": docker_version
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/deployments/history", response_model=list[DeploymentHistoryResponse])
def get_deployment_history(db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    history = db.query(DeploymentHistory).filter(DeploymentHistory.user_id == current_uid).order_by(DeploymentHistory.deployed_at.desc()).all()
    return history

@app.delete("/api/deployments/history")
def clear_deployment_history(db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    db.query(DeploymentHistory).filter(DeploymentHistory.user_id == current_uid).delete(synchronize_session=False)
    db.commit()
    return {"status": "success", "message": "Deployment history cleared successfully"}

@app.delete("/api/deployments/history/{history_id}")
def delete_history_item(history_id: int, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    item = db.query(DeploymentHistory).filter(DeploymentHistory.id == history_id, DeploymentHistory.user_id == current_uid).first()
    if not item:
        raise HTTPException(status_code=404, detail="History item not found")
    db.delete(item)
    db.commit()
    return {"status": "success", "message": "History item deleted successfully"}

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

        if deployment.user_id is not None and str(deployment.user_id) != str(uid):
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
            client = get_docker_client()
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
