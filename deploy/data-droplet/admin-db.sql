-- The Admin database, on the DATA droplet's existing Postgres, beside the main app's.
--
-- admin-core keeps its own state (staff, roles, the audit log, review decisions, rollups)
-- in a database of its own. It is separate from the product database on purpose: the
-- product's roles can never write to it, and a restore of one never touches the other.
--
-- Run ONCE, as the Postgres superuser on the data droplet:
--
--   docker exec -i zapiack_postgres psql -U zapiack -d postgres \
--     -v admin_pw="'<a long random password, letters and digits only>'" \
--     < deploy/data-droplet/admin-db.sql
--
-- Letters and digits only, so the password is safe inside a connection URL.
-- Then, still on the data droplet, create the two least-privilege roles on the PRODUCT
-- database (prisma/grants/zapiack-roles.sql): admin_reader and admin_writer.

CREATE ROLE admin_core LOGIN PASSWORD :admin_pw;

CREATE DATABASE zapiack_admin OWNER admin_core ENCODING 'UTF8';

-- Nobody else needs to connect to it.
REVOKE ALL ON DATABASE zapiack_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE zapiack_admin TO admin_core;
