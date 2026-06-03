-- ==============================================================================
-- SQL MIGRATION SCRIPT FOR DATABASE OPTIMIZATION & INDEXES
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard)
-- ==============================================================================

-- 1. Create index on deployments(user_id) for owner filtering
CREATE INDEX IF NOT EXISTS idx_deployments_user_id 
    ON public.deployments(user_id);

-- 2. Create composite index on deployments(auto_deploy, status) for background task auto-polling queries
CREATE INDEX IF NOT EXISTS idx_deployments_auto_deploy_status 
    ON public.deployments(auto_deploy, status);

-- 3. Create composite index on deployment_history(user_id, deployed_at DESC) for sorting user logs
CREATE INDEX IF NOT EXISTS idx_deployment_history_user_deployed_at 
    ON public.deployment_history(user_id, deployed_at DESC);
