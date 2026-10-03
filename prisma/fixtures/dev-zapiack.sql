-- Development fixtures for the Zapiack product database.
--
-- The console reads this database; api-core owns it in reality. These rows exist so
-- the frontend has something with shape to render: accounts in different states,
-- traffic across channels over two weeks, top-ups, API activity, and a sender ID
-- queue with documents at different stages.
--
--   npm run seed:fixtures
--
-- Safe to re-run: it truncates first.

BEGIN;

TRUNCATE sender_id_documents, sender_id_applications, log_events, tab_transactions,
         transactions, api_activity_logs, subscriptions, product_pricing,
         account_billing, products, api_keys, project_members, projects,
         user_notifications, usage_buffer, accounts, users, plans
         RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------- owners
INSERT INTO users (id, email, "displayName", "emailVerified", "countryCode", timezone, city, region, "lastLoginAt", "createdAt", "updatedAt") VALUES
 ('usr_kano','adeola@kanologistics.ng','Adeola Okafor',true,'NG','Africa/Lagos','Kano','Kano', now() - interval '3 hours', now() - interval '320 days', now()),
 ('usr_lekki','tunde@lekkifintech.com','Tunde Bakare',true,'NG','Africa/Lagos','Lagos','Lagos', now() - interval '1 day', now() - interval '180 days', now()),
 ('usr_abuja','fatima@abujahealth.ng','Fatima Bello',true,'NG','Africa/Lagos','Abuja','FCT', now() - interval '6 hours', now() - interval '95 days', now()),
 ('usr_swift','tech@swiftpay.ng','Chidi Nwosu',false,'NG','Africa/Lagos','Enugu','Enugu', now() - interval '2 hours', now() - interval '26 days', now()),
 ('usr_verde','kwame@verderetail.africa','Kwame Mensah',true,'GH','Africa/Accra','Accra','Greater Accra', now() - interval '20 hours', now() - interval '60 days', now()),
 ('usr_dormant','info@dormanttraders.ng','Emeka Obi',false,'NG','Africa/Lagos','Onitsha','Anambra', now() - interval '250 days', now() - interval '400 days', now()),
 ('usr_new','hello@ikejamotors.ng','Bisi Adewale',false,'NG','Africa/Lagos','Ikeja','Lagos', now() - interval '1 hour', now() - interval '4 days', now());

-- ---------------------------------------------------------------- accounts
-- creditBalance is in CREDITS, not naira.
INSERT INTO accounts (id,"userId","accountStatus","billingAddress","countryCode","creditBalance","currentPeriodEnd","welcomeBonusGrantedAt","createdAt","updatedAt") VALUES
 ('acc_kano','usr_kano','ACTIVE','12 Murtala Way, Kano','NG',48235.7500, now() + interval '24 days', now() - interval '320 days', now() - interval '320 days', now()),
 ('acc_lekki','usr_lekki','ACTIVE','5 Admiralty Way, Lekki, Lagos','NG',18420.0000, now() + interval '19 days', now() - interval '180 days', now() - interval '180 days', now()),
 ('acc_abuja','usr_abuja','ACTIVE','7 Aminu Kano Cres, Wuse II, Abuja','NG',9650.0000, now() + interval '28 days', now() - interval '95 days', now() - interval '95 days', now()),
 ('acc_swift','usr_swift','PROBATION','21 Ogui Road, Enugu','NG',2150.2500, NULL, now() - interval '26 days', now() - interval '26 days', now()),
 ('acc_verde','usr_verde','ACTIVE','14 Oxford St, Osu, Accra','GH',74000.0000, now() + interval '345 days', now() - interval '60 days', now() - interval '60 days', now()),
 ('acc_dormant','usr_dormant','SUSPENDED','3 New Market Rd, Onitsha','NG',0.0000, NULL, now() - interval '400 days', now() - interval '400 days', now()),
 ('acc_new','usr_new','ACTIVE','9 Allen Ave, Ikeja, Lagos','NG',5000.0000, NULL, now() - interval '4 days', now() - interval '4 days', now());

-- ---------------------------------------------------------------- projects
INSERT INTO projects (id,"accountId",name,slug,"emailUsageCount","apiUsageCount","isDeleted","createdAt","updatedAt") VALUES
 ('prj_kano','acc_kano','Delivery Notifications','kano-delivery',1240,3980,false, now() - interval '320 days', now()),
 ('prj_kano_ops','acc_kano','Ops Alerts','kano-ops',180,420,false, now() - interval '120 days', now()),
 ('prj_lekki','acc_lekki','Transaction Alerts','lekki-txn',640,2100,false, now() - interval '180 days', now()),
 ('prj_abuja','acc_abuja','Appointment Reminders','abuja-appointments',910,1450,false, now() - interval '95 days', now()),
 ('prj_swift','acc_swift','SwiftPay Core','swiftpay-core',30,1600,false, now() - interval '26 days', now()),
 ('prj_verde','acc_verde','Order Updates','verde-orders',420,2600,false, now() - interval '60 days', now());

INSERT INTO api_keys (id,"userId","accountId","projectId",name,permission,"usageCount","keyPrefix","keyHash","isActive","isDeleted","lastUsedAt","createdAt") VALUES
 ('key_kano','usr_kano','acc_kano','prj_kano','Production','FULL',3980,'zpk_live_9f3a7c2b1d','hash_1',true,false, now() - interval '12 minutes', now() - interval '320 days'),
 ('key_kano_t','usr_kano','acc_kano','prj_kano_ops','Staging','SEND',420,'zpk_test_41bb9ce07a','hash_2',true,false, now() - interval '9 days', now() - interval '120 days'),
 ('key_lekki','usr_lekki','acc_lekki','prj_lekki','Production','FULL',2100,'zpk_live_77de10c4aa','hash_3',true,false, now() - interval '40 minutes', now() - interval '180 days'),
 ('key_abuja','usr_abuja','acc_abuja','prj_abuja','Production','FULL',1450,'zpk_live_2c5a8be331','hash_4',true,false, now() - interval '2 hours', now() - interval '95 days'),
 ('key_swift','usr_swift','acc_swift','prj_swift','Production','SEND',1600,'zpk_live_5e1f9ab204','hash_5',true,false, now() - interval '20 minutes', now() - interval '26 days'),
 ('key_verde','usr_verde','acc_verde','prj_verde','Production','FULL',2600,'zpk_live_b0f4471e29','hash_6',true,false, now() - interval '35 minutes', now() - interval '60 days'),
 ('key_dormant','usr_dormant','acc_dormant',NULL,'Old key','SEND',12,'zpk_live_deadbeef01','hash_7',false,true, now() - interval '250 days', now() - interval '400 days');

-- ---------------------------------------------------------------- catalogue
INSERT INTO plans (id,name,slug,description,type,channel,"billingInterval",currency,"basePrice","overagePrice","monthlyQuota","dailyQuota","isFree","maxContacts","createdAt","updatedAt") VALUES
 ('plan_free','Starter','starter','Free tier','SUBSCRIPTION','EMAIL','MONTHLY','NGN',0.00,2.50,1000,100,true,500, now() - interval '400 days', now()),
 ('plan_growth','Growth','growth','For growing teams','SUBSCRIPTION','EMAIL','MONTHLY','NGN',50000.00,1.80,50000,5000,false,25000, now() - interval '400 days', now()),
 ('plan_scale','Scale','scale','High volume','SUBSCRIPTION','SMS','MONTHLY','NGN',250000.00,1.20,500000,50000,false,250000, now() - interval '300 days', now()),
 ('plan_ent','Enterprise','enterprise','Annual contract','SUBSCRIPTION','SMS','YEARLY','NGN',1200000.00,0.90,6000000,200000,false,1000000, now() - interval '200 days', now());

INSERT INTO products (id,name,channel,description,"isActive","billingTypes","createdAt","updatedAt") VALUES
 ('prod_sms','SMS','SMS','Outbound SMS',true, ARRAY['CREDIT','SUBSCRIPTION']::"BillingType"[], now() - interval '400 days', now()),
 ('prod_email','Email','EMAIL','Transactional email',true, ARRAY['CREDIT','SUBSCRIPTION']::"BillingType"[], now() - interval '400 days', now());

INSERT INTO product_pricing (id,"productId","countryCode","creditCost","isActive","createdAt","updatedAt") VALUES
 ('pp_sms_ng','prod_sms','NG',4.0000,true, now() - interval '400 days', now()),
 ('pp_sms_gh','prod_sms','GH',9.5000,true, now() - interval '200 days', now()),
 ('pp_email_ng','prod_email','NG',1.5000,true, now() - interval '400 days', now());

INSERT INTO account_billing (id,"accountId","productId",channel,"billingType","createdAt","updatedAt") VALUES
 ('ab_kano_sms','acc_kano','prod_sms','SMS','SUBSCRIPTION', now() - interval '320 days', now()),
 ('ab_kano_eml','acc_kano','prod_email','EMAIL','CREDIT', now() - interval '320 days', now()),
 ('ab_lekki_eml','acc_lekki','prod_email','EMAIL','SUBSCRIPTION', now() - interval '180 days', now()),
 ('ab_abuja_eml','acc_abuja','prod_email','EMAIL','SUBSCRIPTION', now() - interval '95 days', now()),
 ('ab_verde_sms','acc_verde','prod_sms','SMS','SUBSCRIPTION', now() - interval '60 days', now()),
 ('ab_swift_sms','acc_swift','prod_sms','SMS','CREDIT', now() - interval '26 days', now());

INSERT INTO subscriptions (id,"accountId","planId",type,channel,status,"currentPeriodStart","currentPeriodEnd","isTrial","usageCount","createdAt","updatedAt") VALUES
 ('sub_kano','acc_kano','plan_scale','SUBSCRIPTION','SMS','ACTIVE', date_trunc('day',now()) - interval '6 days', date_trunc('day',now()) + interval '24 days', false, 3620, now() - interval '320 days', now()),
 ('sub_lekki','acc_lekki','plan_growth','SUBSCRIPTION','EMAIL','ACTIVE', date_trunc('day',now()) - interval '11 days', date_trunc('day',now()) + interval '19 days', false, 640, now() - interval '180 days', now()),
 ('sub_abuja','acc_abuja','plan_growth','SUBSCRIPTION','EMAIL','ACTIVE', date_trunc('day',now()) - interval '2 days', date_trunc('day',now()) + interval '28 days', false, 910, now() - interval '95 days', now()),
 ('sub_verde','acc_verde','plan_ent','SUBSCRIPTION','SMS','ACTIVE', date_trunc('day',now()) - interval '20 days', date_trunc('day',now()) + interval '345 days', false, 2600, now() - interval '60 days', now()),
 ('sub_dormant','acc_dormant','plan_growth','SUBSCRIPTION','EMAIL','CANCELLED', now() - interval '400 days', now() - interval '210 days', false, 0, now() - interval '400 days', now());

-- ---------------------------------------------------------------- traffic, 14 days
-- cost is in CREDITS. log_events is the usage record; there is no provider cost.
INSERT INTO log_events (id,"accountId","projectId",channel,status,recipient,content,"requestId","senderId",operator,"countryCode",cost,metadata,attempts,"createdAt","updatedAt")
SELECT
  'le_sms_'||g,
  (ARRAY['acc_kano','acc_kano','acc_kano','acc_lekki','acc_abuja','acc_verde'])[1 + (g % 6)],
  (ARRAY['prj_kano','prj_kano','prj_kano_ops','prj_lekki','prj_abuja','prj_verde'])[1 + (g % 6)],
  'SMS',
  (CASE WHEN g % 19 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"LogEventStatus",
  '+23480'||lpad((10000000 + g)::text, 8, '0'),
  'Your parcel is out for delivery.',
  'req_sms_'||g,
  (ARRAY['KANOLOG','KANOLOG','KANOLOG','LEKKIPAY','ABJHEALTH','VERDE'])[1 + (g % 6)],
  (ARRAY['MTN','AIRTEL','GLO','9MOBILE'])[1 + (g % 4)],
  CASE WHEN g % 6 = 5 THEN 'GH' ELSE 'NG' END,
  CASE WHEN g % 6 = 5 THEN 9.5000 ELSE 4.0000 END,
  jsonb_build_object('pages', 1 + (g % 3)),
  1,
  now() - ((g % 14) || ' days')::interval - ((g % 23) || ' hours')::interval - ((g % 59) || ' minutes')::interval,
  now()
FROM generate_series(1, 4200) g;

INSERT INTO log_events (id,"accountId","projectId",channel,status,recipient,content,"requestId","countryCode",cost,metadata,attempts,error,"createdAt","updatedAt")
SELECT
  'le_eml_'||g,
  (ARRAY['acc_kano','acc_abuja','acc_lekki'])[1 + (g % 3)],
  (ARRAY['prj_kano','prj_abuja','prj_lekki'])[1 + (g % 3)],
  'EMAIL',
  (CASE WHEN g % 31 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"LogEventStatus",
  'user'||g||'@example.com',
  'Your monthly statement is ready.',
  'req_eml_'||g,
  'NG',
  1.5000,
  jsonb_build_object('opened', (g % 3 = 0), 'hardBounce', (g % 31 = 0)),
  1,
  CASE WHEN g % 31 = 0 THEN 'HARD_BOUNCE' END,
  now() - ((g % 14) || ' days')::interval - ((g % 20) || ' hours')::interval - ((g % 53) || ' minutes')::interval,
  now()
FROM generate_series(1, 1800) g;

-- A concentrated burst to Ghana today, so the SMS-pumping rule has something to find.
INSERT INTO log_events (id,"accountId","projectId",channel,status,recipient,content,"requestId","senderId",operator,"countryCode",cost,attempts,"createdAt","updatedAt")
SELECT 'le_spike_'||g,'acc_swift','prj_swift','SMS',
  (CASE WHEN g % 4 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"LogEventStatus",
  '+23320'||lpad((3000000 + g)::text, 8, '0'),
  'Verify your account now.', 'req_spk_'||g,'SWIFTPAY','VODAFONE','GH',9.5000,1,
  now() - ((g % 9) || ' hours')::interval - ((g % 47) || ' minutes')::interval, now()
FROM generate_series(1, 1500) g;

-- ---------------------------------------------------------------- money
-- Top-ups in naira. There is no gateway fee column.
INSERT INTO transactions (id,"accountId",type,amount,currency,status,description,reference,"createdAt","creditedAt","updatedAt")
SELECT 'txn_'||g,
  (ARRAY['acc_kano','acc_lekki','acc_abuja','acc_verde'])[1 + (g % 4)],
  'TOPUP',
  (ARRAY[2500,5000,10000,1500])[1 + (g % 4)],
  'NGN',
  (CASE WHEN g % 13 = 0 THEN 'FAILED' ELSE 'SUCCESS' END)::"TransactionStatus",
  'Credit top-up',
  'ref_'||lpad(g::text, 6, '0'),
  now() - ((g % 14) || ' days')::interval,
  CASE WHEN g % 13 = 0 THEN NULL ELSE now() - ((g % 14) || ' days')::interval END,
  now()
FROM generate_series(1, 48) g;

-- The credit ledger: charge is in credits.
INSERT INTO tab_transactions (id,"accountId",channel,type,status,charge,"balanceAfter","requestId","createdAt","updatedAt")
SELECT 'tab_'||g,
  (ARRAY['acc_kano','acc_lekki','acc_abuja','acc_verde'])[1 + (g % 4)],
  (ARRAY['SMS','EMAIL','SMS','SMS'])[1 + (g % 4)]::"ChannelType",
  (CASE WHEN g % 7 = 0 THEN 'CREDIT' WHEN g % 23 = 0 THEN 'REFUND' ELSE 'DEBIT' END)::"TabTransactionType",
  (CASE WHEN g % 19 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"TabTransactionStatus",
  (ARRAY[4.0000,1.5000,9.5000,4.0000])[1 + (g % 4)],
  10000 + (g * 13),
  'req_sms_'||g,
  now() - ((g % 14) || ' days')::interval - ((g % 11) || ' hours')::interval,
  now()
FROM generate_series(1, 240) g;

-- ---------------------------------------------------------------- API activity
INSERT INTO api_activity_logs (id,"requestId","apiKeyPrefix","projectId",ip,"countryCode",city,region,timezone,endpoint,method,"statusCode",status,message,service,"createdAt","updatedAt")
SELECT 'act_'||g,
  'req_act_'||g,
  (ARRAY['zpk_live_9f3a7c2b1d','zpk_live_77de10c4aa','zpk_live_2c5a8be331','zpk_live_b0f4471e29','zpk_live_5e1f9ab204'])[1 + (g % 5)],
  (ARRAY['prj_kano','prj_lekki','prj_abuja','prj_verde','prj_swift'])[1 + (g % 5)],
  (ARRAY['102.89.23.14','197.210.53.9','105.112.44.2','154.160.22.71','41.58.109.6'])[1 + (g % 5)],
  (ARRAY['NG','NG','NG','GH','NG'])[1 + (g % 5)],
  (ARRAY['Kano','Lagos','Abuja','Accra','Enugu'])[1 + (g % 5)],
  (ARRAY['Kano','Lagos','FCT','Greater Accra','Enugu'])[1 + (g % 5)],
  (ARRAY['Africa/Lagos','Africa/Lagos','Africa/Lagos','Africa/Accra','Africa/Lagos'])[1 + (g % 5)],
  (ARRAY['/v1/sms','/v1/email','/v1/sms/bulk','/v1/templates','/v1/contacts'])[1 + (g % 5)],
  (ARRAY['POST','POST','POST','GET','GET'])[1 + (g % 5)],
  (CASE WHEN g % 37 = 0 THEN 500 WHEN g % 11 = 0 THEN 422 ELSE 200 END),
  (CASE WHEN g % 37 = 0 THEN 'FAILED' ELSE 'SUCCESS' END)::"ActivityStatus",
  (CASE WHEN g % 37 = 0 THEN 'Upstream provider timeout' WHEN g % 11 = 0 THEN 'Invalid recipient' ELSE 'OK' END),
  (ARRAY['SMS_SERVICE','EMAIL_SERVICE','SMS_SERVICE','API_SERVICE','API_SERVICE'])[1 + (g % 5)]::"ServiceOrigin",
  now() - ((g % 14) || ' days')::interval - ((g % 24) || ' hours')::interval - ((g % 41) || ' minutes')::interval,
  now()
FROM generate_series(1, 3000) g;

-- ---------------------------------------------------------------- sender IDs
INSERT INTO sender_id_applications (id,"projectId","accountId","businessName","cacRegNo","senderId",status,"rejectionReason","createdAt","updatedAt","submittedAt","reviewedAt") VALUES
 ('app_kano','prj_kano','acc_kano','Kano Logistics Limited','RC1044821','KANOLOG','SUBMITTED',NULL, now() - interval '30 hours', now(), now() - interval '30 hours', NULL),
 ('app_lekki','prj_lekki','acc_lekki','Lekki Fintech Limited','RC2280913','LEKKIPAY','SUBMITTED',NULL, now() - interval '5 hours', now(), now() - interval '5 hours', NULL),
 ('app_abuja','prj_abuja','acc_abuja','Abuja Health Group Ltd','RC1877340','ABJHEALTH','IN_REVIEW',NULL, now() - interval '2 days', now(), now() - interval '2 days', NULL),
 ('app_verde','prj_verde','acc_verde','Verde Retail Africa','RC3390011','VERDE','ACTIVE',NULL, now() - interval '40 days', now(), now() - interval '40 days', now() - interval '38 days'),
 ('app_swift','prj_swift','acc_swift','SwiftPay NG','RC4410222','SWIFTPAY','REJECTED','Sample content reads as an unsolicited promotion.', now() - interval '12 days', now(), now() - interval '12 days', now() - interval '10 days'),
 ('app_draft','prj_kano_ops','acc_kano','Kano Logistics Limited','RC1044821','KANOOPS','DRAFT',NULL, now() - interval '1 day', now(), NULL, NULL);

-- fileUrl points at the CDN in front of the documents bucket.
INSERT INTO sender_id_documents (id,"senderId","fileOriginalName","fileName",type,provider,"fileUrl","createdAt") VALUES
 ('doc_kano_cac','app_kano','CAC Certificate.pdf','cac-certificate.pdf','CAC_CERTIFICATE',NULL,'https://cdn.zapiack.com/sms-documents/app_kano/cac-certificate.pdf', now() - interval '30 hours'),
 ('doc_kano_loa','app_kano','Letter of Authorisation.pdf','letterhead-mtn.pdf','LETTER_OF_AUTHORISATION','MTN','https://cdn.zapiack.com/sms-documents/app_kano/letterhead-mtn.pdf', now() - interval '30 hours'),
 ('doc_kano_id','app_kano','Director ID.jpg','director-id.jpg','ID_CARD',NULL,'https://cdn.zapiack.com/sms-documents/app_kano/director-id.jpg', now() - interval '30 hours'),
 ('doc_lekki_cac','app_lekki','CAC.pdf','cac.pdf','CAC_CERTIFICATE',NULL,'https://cdn.zapiack.com/sms-documents/app_lekki/cac.pdf', now() - interval '5 hours'),
 ('doc_abuja_cac','app_abuja','Abuja CAC.pdf','abuja-cac.pdf','CAC_CERTIFICATE',NULL,'https://cdn.zapiack.com/sms-documents/app_abuja/abuja-cac.pdf', now() - interval '2 days'),
 ('doc_abuja_loa','app_abuja','LOA 9mobile.pdf','letterhead-nine_mobile.pdf','LETTER_OF_AUTHORISATION','9MOBILE','https://cdn.zapiack.com/sms-documents/app_abuja/letterhead-nine_mobile.pdf', now() - interval '2 days'),
 ('doc_verde_cac','app_verde','Verde CAC.pdf','verde-cac.pdf','CAC_CERTIFICATE',NULL,'https://cdn.zapiack.com/sms-documents/app_verde/verde-cac.pdf', now() - interval '40 days');

-- ---------------------------------------------------------------- misc
INSERT INTO usage_buffer (id,"accountId",channel,"dailyCount","monthlyCount","lastSyncedAt","updatedAt") VALUES
 ('ub_kano_sms','acc_kano','SMS',310,3620, now() - interval '4 minutes', now()),
 ('ub_kano_eml','acc_kano','EMAIL',62,640, now() - interval '4 minutes', now()),
 ('ub_verde_sms','acc_verde','SMS',88,2600, now() - interval '6 minutes', now());

INSERT INTO user_notifications (id,"userId","accountId",type,severity,title,body,"actionUrl","readAt","createdAt") VALUES
 ('un_1','usr_kano','acc_kano','SENDER_ID','PENDING','Sender ID under review','KANOLOG is being reviewed and we will update you within one business day.','/sender-ids',NULL, now() - interval '30 hours'),
 ('un_2','usr_verde','acc_verde','SENDER_ID','SUCCESS','Sender ID approved','VERDE is now active on all networks.','/sender-ids', now() - interval '37 days', now() - interval '38 days'),
 ('un_3','usr_swift','acc_swift','SENDER_ID','ERROR','Sender ID rejected','SWIFTPAY was rejected. See the reason and resubmit.','/sender-ids',NULL, now() - interval '10 days');

COMMIT;

SELECT 'accounts' AS table, count(*) FROM accounts
UNION ALL SELECT 'projects', count(*) FROM projects
UNION ALL SELECT 'log_events', count(*) FROM log_events
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'tab_transactions', count(*) FROM tab_transactions
UNION ALL SELECT 'api_activity_logs', count(*) FROM api_activity_logs
UNION ALL SELECT 'sender_id_applications', count(*) FROM sender_id_applications;
