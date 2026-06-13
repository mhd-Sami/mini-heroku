-- ==============================================================================
-- SUPABASE POSTGRESQL DATABASE SCHEMA & RLS POLICIES FOR VESSEL (MINI-HEROKU)
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard)
-- ==============================================================================

-- Migration statement for existing tables:
-- ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS username VARCHAR(255) UNIQUE;
-- ALTER TABLE public.deployments ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN DEFAULT FALSE;
-- ALTER TABLE public.deployments ADD COLUMN IF NOT EXISTS last_commit_hash VARCHAR(255);
-- ALTER TABLE public.deployments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL;
-- ALTER TABLE public.deployments ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);
-- ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS save_history BOOLEAN DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(255) UNIQUE,
    use_case VARCHAR(255) NOT NULL,
    company VARCHAR(255),
    save_history BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Set up policies for user_profiles
CREATE POLICY "Users can select their own profile" 
    ON public.user_profiles FOR SELECT 
    USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile" 
    ON public.user_profiles FOR INSERT 
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile" 
    ON public.user_profiles FOR UPDATE 
    USING (auth.uid() = id);

-- 2. Create Deployments Table
-- Stores container and git configuration for microservices, linked to Supabase Auth's internal users
CREATE TABLE IF NOT EXISTS public.deployments (
    id SERIAL PRIMARY KEY,
    app_name VARCHAR(255) UNIQUE NOT NULL,
    git_url VARCHAR(1024) NOT NULL,
    local_domain VARCHAR(255) NOT NULL,
    port INTEGER DEFAULT 80 NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' NOT NULL,
    cpu_limit DOUBLE PRECISION,
    memory_limit VARCHAR(50),
    env_vars TEXT, -- Serialized JSON string of environment variables
    container_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    auto_deploy BOOLEAN DEFAULT FALSE NOT NULL,
    last_commit_hash VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    custom_domain VARCHAR(255)
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;

-- Set up policies for deployments
CREATE POLICY "Users can select their own deployments" 
    ON public.deployments FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own deployments" 
    ON public.deployments FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own deployments" 
    ON public.deployments FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own deployments" 
    ON public.deployments FOR DELETE 
    USING (auth.uid() = user_id);

-- 3. Create Deployment History Table
CREATE TABLE IF NOT EXISTS public.deployment_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    git_url VARCHAR(1024) NOT NULL,
    status VARCHAR(50) NOT NULL,
    last_commit_hash VARCHAR(255),
    deployed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.deployment_history ENABLE ROW LEVEL SECURITY;

-- Set up policies for deployment_history
CREATE POLICY "Users can select their own deployment history" 
    ON public.deployment_history FOR SELECT 
    USING (auth.uid() = user_id);

-- 4. Create Builds Table
CREATE TABLE IF NOT EXISTS public.builds (
    id SERIAL PRIMARY KEY,
    app_name VARCHAR(255) REFERENCES public.deployments(app_name) ON DELETE CASCADE NOT NULL,
    version_tag VARCHAR(255) NOT NULL,
    commit_hash VARCHAR(255),
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;

-- Set up policies for builds
CREATE POLICY "Users can select their own builds" 
    ON public.builds FOR SELECT 
    USING (EXISTS (
        SELECT 1 FROM public.deployments 
        WHERE public.deployments.app_name = public.builds.app_name 
          AND public.deployments.user_id = auth.uid()
    ));

-- Note: The FastAPI backend connects as the postgres superuser (via connection pooling),
-- which automatically bypasses RLS policies. This allows backend background tasks to update 
-- container build/running status without needing to spoof user auth contexts.
