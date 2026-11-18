-- #3308 PR A / cor:agt:080:24: names only, before the staffing/member narrowing deploy.
-- No grant rows are created. A person who manages the App provisions them through grantApp.
ALTER TABLE app_grants DROP CONSTRAINT IF EXISTS chk_app_grants_shape;
ALTER TABLE app_grants ADD CONSTRAINT chk_app_grants_shape CHECK (
  name IN ('ticker.subscribe-workers', 'workers.staff', 'app.members')
);
