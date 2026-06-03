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

class EventBroadcaster:
    def __init__(self):
        # user_id -> set of WebSockets
        self.connections: Dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        if user_id not in self.connections:
            self.connections[user_id] = set()
        self.connections[user_id].add(websocket)

    def disconnect(self, user_id: str, websocket: WebSocket):
        if user_id in self.connections:
            self.connections[user_id].discard(websocket)
            if not self.connections[user_id]:
                del self.connections[user_id]

    async def broadcast_to_user(self, user_id: str, event_type: str, data: dict):
        if user_id in self.connections:
            payload = {"type": event_type, "data": data}
            message = json.dumps(payload)
            active_connections = list(self.connections[user_id])
            for connection in active_connections:
                try:
                    await connection.send_text(message)
                except Exception:
                    self.connections[user_id].discard(connection)

event_broadcaster = EventBroadcaster()

def send_realtime_event(user_id: str, event_type: str, data: dict):
    if not user_id:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
        
    if loop and loop.is_running():
        loop.create_task(event_broadcaster.broadcast_to_user(str(user_id), event_type, data))
    else:
        try:
            main_loop = asyncio.get_event_loop()
            if main_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    event_broadcaster.broadcast_to_user(str(user_id), event_type, data), 
                    main_loop
                )
        except Exception as e:
            print(f"Error sending real-time event: {e}", flush=True)

def serialize_deployment(d: Deployment) -> dict:
    return {
        "id": d.id,
        "app_name": d.app_name,
        "git_url": d.git_url,
        "local_domain": d.local_domain,
        "port": d.port,
        "status": d.status,
        "cpu_limit": d.cpu_limit,
        "memory_limit": d.memory_limit,
        "env_vars": json.loads(d.env_vars) if d.env_vars else {},
        "auto_deploy": d.auto_deploy,
        "last_commit_hash": d.last_commit_hash,
        "updated_at": d.updated_at.isoformat() if d.updated_at else (d.created_at.isoformat() if d.created_at else None),
        "created_at": d.created_at.isoformat() if d.created_at else None
    }

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

        # Auto-detect port if port is 0
        final_port = port
        if port == 0:
            try:
                log_message(app_name, "Auto-detecting port from built Docker image...")
                image = client.images.get(app_name)
                exposed_ports = image.attrs.get('Config', {}).get('ExposedPorts', {})
                if exposed_ports:
                    ports = [int(p.split('/')[0]) for p in exposed_ports.keys()]
                    # Preferred application ports in order of priority
                    preferred = [8080, 8000, 5000, 3000, 8081, 4000, 80]
                    detected_port = None
                    for p in preferred:
                        if p in ports:
                            detected_port = p
                            break
                    if detected_port is None:
                        # Exclude standard admin/db ports
                        excluded = {2019, 443, 3306, 5432, 27017, 6379}
                        remaining = [p for p in ports if p not in excluded]
                        detected_port = remaining[0] if remaining else ports[0]
                        
                    log_message(app_name, f"Successfully auto-detected port: {detected_port}")
                    final_port = detected_port
                else:
                    log_message(app_name, "No EXPOSE ports found in Dockerfile. Falling back to default port 80.")
                    final_port = 80
            except Exception as pe:
                log_message(app_name, f"Port auto-detection failed: {pe}. Falling back to default port 80.")
                final_port = 80

        # 5. Launch Container with Traefik tags
        log_message(app_name, f"Launching container on port {final_port}...")

        # Traefik router/service identifiers in label keys must be strictly alphanumeric
        route_name = re.sub(r'[^a-zA-Z0-9]', '', app_name)

        labels = {
            "traefik.enable": "true",
            "traefik.docker.network": "mini-heroku-net",
            f"traefik.http.routers.{route_name}.rule": f'Host("{app_name}.localhost")',
            f"traefik.http.routers.{route_name}.entrypoints": "web",
            f"traefik.http.services.{route_name}.loadbalancer.server.port": str(final_port)
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
        deployment.port = final_port
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
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))

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
                    hist_data = {
                        "id": history_entry.id,
                        "app_name": history_entry.app_name,
                        "git_url": history_entry.git_url,
                        "status": history_entry.status,
                        "last_commit_hash": history_entry.last_commit_hash,
                        "deployed_at": history_entry.deployed_at.isoformat()
                    }
                    send_realtime_event(deployment.user_id, "history_added", hist_data)
            except Exception as hist_err:
                print(f"Error logging success deployment history: {hist_err}", flush=True)

    except Exception as e:
        log_message(app_name, f"Deployment ERROR: {str(e)}")
        deployment.status = "failed"
        deployment.updated_at = datetime.utcnow()
        db.commit()
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))

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
                    hist_data = {
                        "id": history_entry.id,
                        "app_name": history_entry.app_name,
                        "git_url": history_entry.git_url,
                        "status": history_entry.status,
                        "last_commit_hash": history_entry.last_commit_hash,
                        "deployed_at": history_entry.deployed_at.isoformat()
                    }
                    send_realtime_event(deployment.user_id, "history_added", hist_data)
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

class ConfigureAppRequest(BaseModel):
    git_url: Optional[str] = None
    port: Optional[int] = None
    cpu_limit: Optional[float] = None
    memory_limit: Optional[str] = None
    env_vars: Optional[Dict[str, str]] = None
    auto_deploy: Optional[bool] = None

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
                    send_realtime_event(app.user_id, "app_updated", serialize_deployment(app))
                    
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

    # Send building status update
    d_rec = db.query(Deployment).filter(Deployment.id == db_id).first()
    if d_rec:
        send_realtime_event(current_uid, "app_updated", serialize_deployment(d_rec))

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
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))
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
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))
        return {"status": "success", "message": f"App {app_name} stopped"}
    except docker.errors.NotFound:
        deployment.status = "stopped"
        db.commit()
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))
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
        send_realtime_event(deployment.user_id, "app_updated", serialize_deployment(deployment))
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
            
        send_realtime_event(current_uid, "app_deleted", {"app_name": app_name})
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

@app.post("/api/apps/{app_name}/configure")
def configure_app(
    app_name: str,
    request: ConfigureAppRequest,
    db: Session = Depends(get_db),
    current_uid: str = Depends(get_current_user)
):
    deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
    if not deployment:
        raise HTTPException(status_code=404, detail="App not found")
    if deployment.user_id is not None and str(deployment.user_id) != str(current_uid):
        raise HTTPException(status_code=403, detail="Permission denied")

    if deployment.user_id is None:
        deployment.user_id = current_uid
        db.commit()

    # Update database values
    if request.git_url is not None:
        deployment.git_url = request.git_url
    if request.port is not None:
        deployment.port = request.port
    if request.cpu_limit is not None:
        deployment.cpu_limit = request.cpu_limit
    if request.memory_limit is not None:
        deployment.memory_limit = request.memory_limit
    if request.env_vars is not None:
        deployment.env_vars = json.dumps(request.env_vars)
    if request.auto_deploy is not None:
        deployment.auto_deploy = request.auto_deploy

    deployment.updated_at = datetime.utcnow()
    db.commit()

    # If the app is currently running, we need to recreate the container to apply changes
    if deployment.status == "running":
        try:
            client = get_docker_client()
            
            # Stop and remove old container
            try:
                old_container = client.containers.get(app_name)
                old_container.stop(timeout=5)
                old_container.remove()
            except docker.errors.NotFound:
                pass

            # Launch new container with new settings
            route_name = re.sub(r'[^a-zA-Z0-9]', '', app_name)
            labels = {
                "traefik.enable": "true",
                "traefik.docker.network": "mini-heroku-net",
                f"traefik.http.routers.{route_name}.rule": f'Host("{app_name}.localhost")',
                f"traefik.http.routers.{route_name}.entrypoints": "web",
                f"traefik.http.services.{route_name}.loadbalancer.server.port": str(deployment.port)
            }
            nano_cpus = int(deployment.cpu_limit * 1e9) if deployment.cpu_limit else None
            env_vars_dict = request.env_vars if request.env_vars is not None else (json.loads(deployment.env_vars) if deployment.env_vars else {})

            container = client.containers.run(
                image=app_name,
                name=app_name,
                detach=True,
                network="mini-heroku-net",
                labels=labels,
                environment=env_vars_dict,
                nano_cpus=nano_cpus,
                mem_limit=deployment.memory_limit if deployment.memory_limit else None,
                restart_policy={"Name": "on-failure"}
            )
            deployment.container_id = container.id
            db.commit()
            log_message(app_name, "Container recreated to apply updated configuration.")
        except Exception as e:
            deployment.status = "failed"
            db.commit()
            
            # Send status update even on failure
            app_data = {
                "id": deployment.id,
                "app_name": deployment.app_name,
                "git_url": deployment.git_url,
                "local_domain": deployment.local_domain,
                "port": deployment.port,
                "status": deployment.status,
                "cpu_limit": deployment.cpu_limit,
                "memory_limit": deployment.memory_limit,
                "env_vars": json.loads(deployment.env_vars) if deployment.env_vars else {},
                "auto_deploy": deployment.auto_deploy,
                "last_commit_hash": deployment.last_commit_hash,
                "updated_at": deployment.updated_at.isoformat(),
                "created_at": deployment.created_at.isoformat()
            }
            send_realtime_event(deployment.user_id, "app_updated", app_data)
            raise HTTPException(status_code=500, detail=f"Failed to recreate container: {str(e)}")

    # Send update event
    app_data = {
        "id": deployment.id,
        "app_name": deployment.app_name,
        "git_url": deployment.git_url,
        "local_domain": deployment.local_domain,
        "port": deployment.port,
        "status": deployment.status,
        "cpu_limit": deployment.cpu_limit,
        "memory_limit": deployment.memory_limit,
        "env_vars": json.loads(deployment.env_vars) if deployment.env_vars else {},
        "auto_deploy": deployment.auto_deploy,
        "last_commit_hash": deployment.last_commit_hash,
        "updated_at": deployment.updated_at.isoformat(),
        "created_at": deployment.created_at.isoformat()
    }
    send_realtime_event(deployment.user_id, "app_updated", app_data)

    return {"status": "success", "message": "App configuration updated successfully", "app": app_data}

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
                
    # Fetch container insights from Docker
    image_size_mb = 0.0
    ip_address = ""
    started_at = ""
    restart_count = 0
    try:
        client = get_docker_client()
        try:
            image = client.images.get(app_name)
            image_size_mb = round(image.attrs.get("Size", 0) / (1024 * 1024), 2)
        except Exception:
            pass
        if deployment.status == "running":
            try:
                container = client.containers.get(app_name)
                state = container.attrs.get("State", {})
                started_at = state.get("StartedAt", "")
                restart_count = state.get("RestartCount", 0)
                networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
                for net_name, net_info in networks.items():
                    if net_name == "mini-heroku-net":
                        ip_address = net_info.get("IPAddress", "")
                        break
            except Exception:
                pass
    except Exception:
        pass

    # Inject database metadata and Docker insights
    res["image_size_mb"] = image_size_mb
    res["ip_address"] = ip_address
    res["started_at"] = started_at
    res["restart_count"] = restart_count
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
    send_realtime_event(current_uid, "history_cleared", {})
    return {"status": "success", "message": "Deployment history cleared successfully"}

@app.delete("/api/deployments/history/{history_id}")
def delete_history_item(history_id: int, db: Session = Depends(get_db), current_uid: str = Depends(get_current_user)):
    item = db.query(DeploymentHistory).filter(DeploymentHistory.id == history_id, DeploymentHistory.user_id == current_uid).first()
    if not item:
        raise HTTPException(status_code=404, detail="History item not found")
    db.delete(item)
    db.commit()
    send_realtime_event(current_uid, "history_deleted", {"id": history_id})
    return {"status": "success", "message": "History item deleted successfully"}

@app.websocket("/ws/events")
async def websocket_events(websocket: WebSocket, token: Optional[str] = None):
    await websocket.accept()
    if not token:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": "Authentication token missing"}))
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
            await websocket.send_text(json.dumps({"type": "error", "message": "Invalid or expired authentication token."}))
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    await event_broadcaster.connect(uid, websocket)
    try:
        while True:
            # Keep connection open and detect client disconnects
            await websocket.receive_text()
    except Exception:
        pass
    finally:
        event_broadcaster.disconnect(uid, websocket)

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

@app.websocket("/ws/apps/{app_name}/console")
async def websocket_console(websocket: WebSocket, app_name: str, token: Optional[str] = None):
    await websocket.accept()

    if not token:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": "Authentication token missing"}))
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
            print(f"WS console auth error: {e}", flush=True)
            pass

    if not uid:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": "Invalid or expired authentication token."}))
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    db = SessionLocal()
    try:
        deployment = db.query(Deployment).filter(Deployment.app_name == app_name).first()
        if not deployment:
            await websocket.send_text(json.dumps({"type": "error", "message": "Application not found."}))
            await websocket.close(code=1008)
            return

        if deployment.user_id is not None and str(deployment.user_id) != str(uid):
            await websocket.send_text(json.dumps({"type": "error", "message": "Access denied."}))
            await websocket.close(code=1008)
            return
    except Exception as err:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": f"Server error: {err}"}))
            await websocket.close(code=1008)
        except Exception:
            pass
        return
    finally:
        db.close()

    try:
        client = get_docker_client()
    except Exception as docker_err:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": f"Docker host unreachable: {docker_err}"}))
            await websocket.close()
        except Exception:
            pass
        return

    try:
        while True:
            # Receive a command string from client
            message_text = await websocket.receive_text()
            try:
                msg_data = json.loads(message_text)
                cmd = msg_data.get("command", "").strip()
            except Exception:
                cmd = message_text.strip()

            if not cmd:
                continue

            # Check if container is running
            try:
                container = client.containers.get(app_name)
                if container.status != "running":
                    await websocket.send_text(json.dumps({"type": "output", "data": "Error: Application container is not running.\r\n"}))
                    continue
            except docker.errors.NotFound:
                await websocket.send_text(json.dumps({"type": "output", "data": "Error: Application container does not exist.\r\n"}))
                continue

            await websocket.send_text(json.dumps({"type": "status", "data": "running"}))

            # Run the command inside the container using shell
            try:
                # Wrap command in shell execution
                shell_cmd = ["/bin/sh", "-c", cmd]
                
                # Create exec instance
                exec_instance = client.api.exec_create(
                    container.id, 
                    shell_cmd, 
                    stdout=True, 
                    stderr=True, 
                    stdin=False, 
                    tty=True
                )
                
                # Start exec stream
                output_stream = client.api.exec_start(exec_instance['Id'], stream=True)

                def get_next_chunk(stream_iter):
                    try:
                        return next(stream_iter)
                    except StopIteration:
                        return None

                stream_iter = iter(output_stream)
                while True:
                    chunk = await asyncio.to_thread(get_next_chunk, stream_iter)
                    if chunk is None:
                        break
                    
                    decoded_chunk = chunk.decode("utf-8", errors="ignore")
                    await websocket.send_text(json.dumps({"type": "output", "data": decoded_chunk}))

                # Send exit code if possible
                inspect_info = client.api.exec_inspect(exec_instance['Id'])
                exit_code = inspect_info.get("ExitCode", 0)
                await websocket.send_text(json.dumps({"type": "exit", "code": exit_code}))

            except Exception as cmd_err:
                await websocket.send_text(json.dumps({"type": "output", "data": f"Execution Error: {cmd_err}\r\n"}))

    except Exception:
        # Connection closed or client disconnected
        pass

# Mount frontend files (served at app root)
frontend_path = "/app/frontend"
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:
    # Local dev fallback
    local_frontend = os.path.join(os.path.dirname(__file__), "../frontend")
    if os.path.exists(local_frontend):
        app.mount("/", StaticFiles(directory=local_frontend, html=True), name="frontend")
