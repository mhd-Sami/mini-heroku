-- ==============================================================================
-- SQL UPDATE SCRIPT FOR DEPLOYMENT HISTORY FEATURE
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard)
-- ==============================================================================

-- 1. Add save_history preference to user_profiles
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS save_history BOOLEAN DEFAULT TRUE NOT NULL;

-- 2. Create Deployment History Table
CREATE TABLE IF NOT EXISTS public.deployment_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    app_name VARCHAR(255) NOT NULL,
    git_url VARCHAR(1024) NOT NULL,
    status VARCHAR(50) NOT NULL, -- success, failed
    last_commit_hash VARCHAR(255),
    deployed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Enable Row Level Security (RLS) on the history table
ALTER TABLE public.deployment_history ENABLE ROW LEVEL SECURITY;

-- 4. Setup RLS Policies for deployment_history
CREATE POLICY "Users can select their own deployment history" 
    ON public.deployment_history FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own deployment history" 
    ON public.deployment_history FOR DELETE 
    USING (auth.uid() = user_id);

-- Note: The FastAPI backend connects as the postgres superuser (via connection pooling),
-- which automatically bypasses RLS policies and can write history records.
