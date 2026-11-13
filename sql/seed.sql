-- =============================================================================
-- Demo data. EVERYTHING HERE IS FICTIONAL: invented people and companies, so
-- a fresh install has a populated board to click around. Delete it freely:
-- open a deal and use "Delete", or run: delete from deals;
-- Loaded by `npm run db:setup -- --seed` (only onto an empty board).
-- =============================================================================

do $seed$
declare
  admin_email text;
  admin_name  text;
  p_jordan uuid; p_riley uuid; p_sam uuid; p_morgan uuid;
  p_taylor uuid; p_casey uuid; p_jamie uuid; p_drew uuid;
  g1 text := 'local-' || gen_random_uuid();
  g2 text := 'local-' || gen_random_uuid();
  g3 text := 'local-' || gen_random_uuid();
  g4 text := 'local-' || gen_random_uuid();
  g5 text := 'local-' || gen_random_uuid();
  g6 text := 'local-' || gen_random_uuid();
begin
  select email, name into admin_email, admin_name
    from app_users order by created_at limit 1;
  if admin_email is null then
    raise exception 'Create a user first (set FIRST_ADMIN_EMAIL and run db:setup).';
  end if;

  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Jordan Avery', 'Example University', 'CEO', 'Ledgerly', admin_email, 'ready')
  returning id into p_jordan;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Riley Chen', 'Sample Institute', 'CTO', 'Ledgerly', admin_email, 'ready')
  returning id into p_riley;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Sam Patel', 'Sample Institute', 'Founder', 'Stacktrace', admin_email, 'ready')
  returning id into p_sam;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Morgan Diaz', 'Example University', 'CEO', 'Orbit Ledger', admin_email, 'ready')
  returning id into p_morgan;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Taylor Brooks', 'Demo College', 'Founder', 'Signal Garden', admin_email, 'ready')
  returning id into p_taylor;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Casey Nguyen', 'Demo College', 'Co-founder', 'Signal Garden', admin_email, 'ready')
  returning id into p_casey;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Jamie Ortiz', 'Sample Institute', 'CEO', 'Lattice Health', admin_email, 'ready')
  returning id into p_jamie;
  insert into network_people (name, school, current_title, current_organization, added_by, profile_status)
  values ('Drew Kim', 'Example University', 'Founder', 'Paper Planes', admin_email, 'ready')
  returning id into p_drew;

  insert into deals (gid, name, notes, stage, section_gid, schools, owner, created_on, modified_on,
                     financing_amount, round, created_by, visibility, source)
  values
    (g1, 'Jordan Avery, Riley Chen // Ledgerly',
     E'Workflow automation for small accounting firms. Pre-seed, raising $1.5M on a SAFE.\n\nTraction: 12 paying firms, ~$9k MRR, growing 20% month over month.',
     'diligence', 'diligence', array['Fintech'], admin_name, current_date - 30, current_date - 2,
     '$1.5M', 'Pre-Seed', admin_email, 'team', 'demo'),
    (g2, 'Sam Patel // Stacktrace',
     E'Developer tool that explains cryptic production errors.\n\nFirst call went well; wants a follow-up with the CTO.',
     'first-meeting', 'first-meeting', array['DevTools'], admin_name, current_date - 12, current_date - 5,
     '$800k', 'Pre-Seed', admin_email, 'team', 'demo'),
    (g3, 'Morgan Diaz // Orbit Ledger',
     E'Treasury tooling for satellite operators.\n\nIntro from a portfolio founder. Strong team, early market.',
     'to-meet', 'to-meet', array['Space','Fintech'], admin_name, current_date - 3, current_date - 3,
     null, 'Seed', admin_email, 'team', 'demo'),
    (g4, 'Taylor Brooks, Casey Nguyen // Signal Garden',
     E'Community platform for hardware hobbyists.\n\nLiked the founders; worried about monetization.',
     'cultivate', 'cultivate', array['Consumer'], admin_name, current_date - 45, current_date - 9,
     '$500k', 'Pre-Seed', admin_email, 'team', 'demo'),
    (g5, 'Jamie Ortiz // Lattice Health',
     E'Scheduling software for rural clinics.\n\nPassed: sales cycles too long for this stage.',
     'passed', 'passed', array['Health'], admin_name, current_date - 90, current_date - 60,
     '$2M', 'Seed', admin_email, 'team', 'demo'),
    (g6, 'Drew Kim // Paper Planes',
     E'Logistics marketplace for small-batch shipping.\n\nTerm sheet discussions underway.',
     'offered', 'offered', array['Logistics'], admin_name, current_date - 60, current_date - 1,
     '$3M', 'Seed', admin_email, 'team', 'demo');

  insert into deal_founders (deal_gid, person_id, founder_role, created_by) values
    (g1, p_jordan, 'Founder', admin_email), (g1, p_riley, 'Founder', admin_email),
    (g2, p_sam, 'Founder', admin_email), (g3, p_morgan, 'Founder', admin_email),
    (g4, p_taylor, 'Founder', admin_email), (g4, p_casey, 'Founder', admin_email),
    (g5, p_jamie, 'Founder', admin_email), (g6, p_drew, 'Founder', admin_email);

  insert into deal_owners (deal_gid, email)
  select g, admin_email from unnest(array[g1,g2,g3,g4,g5,g6]) as g;

  insert into deal_decisions (deal_gid, decision, rationale, actor_email, actor_name) values
    (g1, 'diligence', 'Real revenue and a tight wedge. Worth a deeper look at retention.', admin_email, admin_name),
    (g5, 'pass', 'Clinic sales cycles are long and the team has no enterprise sales experience yet.', admin_email, admin_name),
    (g6, 'invest', 'Fast growth, repeat customers, and a clear use of funds.', admin_email, admin_name);

  insert into deal_comments (deal_gid, author_email, author_name, body) values
    (g1, admin_email, admin_name, 'Customer calls were glowing. Asking for two more references.'),
    (g2, admin_email, admin_name, 'Send the founders a note about the product roadmap before the next call.');
end
$seed$;
