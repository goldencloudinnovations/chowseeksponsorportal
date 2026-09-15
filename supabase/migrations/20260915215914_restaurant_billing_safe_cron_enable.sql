do $$
begin
  if exists (select 1 from cron.job where jobname = 'restaurant-billing-usage-sync') then
    perform cron.unschedule('restaurant-billing-usage-sync');
  end if;

  perform cron.schedule(
    'restaurant-billing-usage-sync',
    '* * * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'restaurant_usage_function_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'restaurant_usage_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 50000
      ) as request_id;
    $cron$
  );
end;
$$;
