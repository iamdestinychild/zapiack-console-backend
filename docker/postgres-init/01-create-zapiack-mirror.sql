-- admin-core talks to two databases: the Admin DB it owns, and the Zapiack product
-- DB it reads. The compose POSTGRES_DB creates the first; this creates the second so
-- the console is developable without the product stack running.
--
-- Runs once, on first initialisation of an empty data volume.
--
-- In staging and production this database does not exist here at all:
-- ZAPIACK_READ_DATABASE_URL points at the product read replica, through a role that
-- holds SELECT and nothing else.
CREATE DATABASE zapiack;
