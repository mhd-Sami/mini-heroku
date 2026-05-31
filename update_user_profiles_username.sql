-- ==============================================================================
-- Add username column to user_profiles table for Vessel (mini-heroku)
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard)
-- ==============================================================================

ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS username VARCHAR(255) UNIQUE;
