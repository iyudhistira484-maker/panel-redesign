<?php
// Disposable GitHub Actions fixture. Never seed an existing Panel database.
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::connection()->getDatabaseName() !== 'panel_adoption_fixture' || getenv('RELAY_LEGACY_FIXTURE') !== '1') {
    throw new RuntimeException('Disposable legacy database required');
}
$uuid = getenv('RELAY_ADOPTION_SERVER_UUID');
if (($argv[1] ?? '') === 'status') {
    $server = DB::table('servers')->where('uuid', ($argv[2] ?? '') === 'second' ? getenv('RELAY_ADOPTION_SECOND_UUID') : $uuid)->first(['status', 'installed_at']);
    echo json_encode($server, JSON_THROW_ON_ERROR);
    exit;
}
if (in_array(($argv[1] ?? ''), ['client-key', 'application-key'], true)) {
    $application = $argv[1] === 'application-key';
    $account = DB::table('users')->where('email', $application ? 'outsider@example.test' : 'adoption@example.test')->first(['id']);
    if (!$account) { throw new RuntimeException('Fixture account missing'); }
    $service = $app->make(\Pterodactyl\Services\Api\KeyCreationService::class);
    if ($application) { DB::table('users')->where('id', $account->id)->update(['root_admin' => true]); }
    $key = $service->setKeyType($application ? \Pterodactyl\Models\ApiKey::TYPE_APPLICATION : \Pterodactyl\Models\ApiKey::TYPE_ACCOUNT)->handle([
        'user_id' => $account->id, 'memo' => 'Disposable Relay comparison', 'allowed_ips' => [],
    ], $application ? ['r_servers' => 1] : []);
    echo $key->identifier . $app->make('encrypter')->decrypt($key->token);
    exit;
}
DB::transaction(function () use ($uuid, $app) {
    $location = DB::table('locations')->insertGetId(['short' => 'fixture']);
    $node = DB::table('nodes')->insertGetId([
        'uuid' => '3ab63670-f83b-4a2c-adeb-5b2852859319', 'public' => 1,
        'name' => 'Adoption node', 'location_id' => $location, 'fqdn' => '127.0.0.1',
        'scheme' => 'http', 'memory' => 1024, 'disk' => 1024, 'daemonListen' => 18080,
        'daemon_token_id' => getenv('RELAY_WINGS_TEST_TOKEN_ID'),
        'daemon_token' => $app->make('encrypter')->encrypt(getenv('RELAY_WINGS_TEST_TOKEN')),
    ]);
    $nest = DB::table('nests')->insertGetId(['uuid' => getenv('RELAY_ADOPTION_NEST_UUID'), 'author' => 'fixture@example.test', 'name' => 'Adoption fixture']);
    $startup = 'sh /home/container/relay-start.sh';
    $image = '~relay-wings-contract-workload:ci';
    $egg = DB::table('eggs')->insertGetId([
        'uuid' => getenv('RELAY_ADOPTION_EGG_UUID'), 'nest_id' => $nest, 'author' => 'fixture@example.test',
        'name' => 'Adoption fixture', 'docker_images' => json_encode(['Fixture' => $image]),
        'startup' => $startup, 'config_startup' => '{"done":"RELAY_CONTRACT_READY"}',
        'config_stop' => '^SIGTERM', 'config_files' => '{}', 'config_logs' => '{}',
        'script_container' => 'alpine:3.22.2', 'script_entry' => 'sh',
        'script_install' => <<<'SCRIPT'
#!/bin/sh
set -eu
cat > /mnt/server/relay-start.sh <<'WORKLOAD'
#!/bin/sh
set -eu
trap 'exit 0' TERM INT
printf '%s\n' RELAY_CONTRACT_READY 'RELAY_DIAGNOSTIC runtime=ready config=loaded' 'RELAY_DIAGNOSTIC runtime=ready config=loaded token=fixture-console-secret'
while :; do
    if IFS= read -r command; then
        case "$command" in
            'relay-marker '*)
                marker=${command#relay-marker }
                case "$marker" in
                    ''|*[!0-9a-f]*) ;;
                    *) if [ "${#marker}" -eq 24 ]; then printf 'RELAY_COMMAND_ACK %s\n' "$marker"; fi ;;
                esac
                ;;
        esac
    else
        sleep 1 & wait "$!"
    fi
done
WORKLOAD
chmod 644 /mnt/server/relay-start.sh
mkdir -p /mnt/server/fixture-docs
ln -sfn fixture-docs /mnt/server/fixture-link
printf '%s\n' '<strong>fixture preview</strong>' > /mnt/server/fixture-docs/example.txt
printf '\000fixture' > /mnt/server/fixture-docs/binary.txt
dd if=/dev/zero of=/mnt/server/fixture-docs/large.txt bs=1024 count=17 2>/dev/null
ln -sfn example.txt /mnt/server/fixture-docs/link.txt
SCRIPT,
    ]);
    $owner = DB::table('users')->insertGetId([
        'uuid' => getenv('RELAY_ADOPTION_OWNER_UUID'), 'username' => 'fixture',
        'email' => 'adoption@example.test', 'password' => 'disabled', 'use_totp' => 0,
    ]);
    foreach (['collaborator', 'outsider'] as $role) {
        $users[$role] = DB::table('users')->insertGetId([
            'uuid' => getenv('RELAY_ADOPTION_' . strtoupper($role) . '_UUID'), 'username' => $role,
            'email' => $role . '@example.test', 'password' => 'disabled', 'use_totp' => 0,
        ]);
    }
    $allocation = DB::table('allocations')->insertGetId(['node_id' => $node, 'ip' => '127.0.0.1', 'port' => 25610]);
    $server = DB::table('servers')->insertGetId([
        'created_at' => now(), 'updated_at' => now(), 'external_id' => 'fixture:Legacy A',
        'uuid' => $uuid, 'uuidShort' => substr($uuid, 0, 8), 'node_id' => $node,
        'name' => 'Existing staging workload', 'description' => 'Disposable', 'status' => 'installing',
        'owner_id' => $owner, 'memory' => 128, 'swap' => 0, 'disk' => 64, 'io' => 500, 'cpu' => 50,
        'allocation_id' => $allocation, 'nest_id' => $nest, 'egg_id' => $egg, 'startup' => $startup, 'image' => $image,
    ]);
    DB::table('allocations')->where('id', $allocation)->update(['server_id' => $server]);
    DB::table('subusers')->insert(['user_id' => $users['collaborator'], 'server_id' => $server, 'permissions' => json_encode(['activity.read', 'control.start'], JSON_THROW_ON_ERROR)]);
    DB::table('allocations')->insert(['node_id' => $node, 'ip' => '127.0.0.2', 'port' => 25616, 'server_id' => $server]);
    $copy = (array) DB::table('eggs')->where('id', $egg)->first();
    unset($copy['id']);
    $copy['uuid'] = getenv('RELAY_ADOPTION_SECOND_EGG_UUID');
    $copy['name'] = 'Second adoption fixture';
    $otherEgg = DB::table('eggs')->insertGetId($copy);
    $secondNode = DB::table('nodes')->insertGetId([
        'uuid' => '33113cc5-78fb-4cd0-881b-326c3888b38b', 'public' => 1,
        'name' => 'Second adoption node', 'location_id' => $location, 'fqdn' => '127.0.0.1',
        'scheme' => 'http', 'memory' => 1024, 'disk' => 1024, 'daemonListen' => 18081,
        'daemon_token_id' => getenv('RELAY_SECOND_NODE_TOKEN_ID'),
        'daemon_token' => $app->make('encrypter')->encrypt(getenv('RELAY_SECOND_NODE_TOKEN')),
    ]);
    $otherAllocation = DB::table('allocations')->insertGetId(['node_id' => $secondNode, 'ip' => '127.0.0.1', 'port' => 25611]);
    $other = (array) DB::table('servers')->where('id', $server)->first();
    unset($other['id']);
    $other['uuid'] = getenv('RELAY_ADOPTION_SECOND_UUID');
    $other['external_id'] = null;
    $other['uuidShort'] = substr($other['uuid'], 0, 8);
    $other['node_id'] = $secondNode;
    $other['egg_id'] = $otherEgg;
    $other['allocation_id'] = $otherAllocation;
    $otherServer = DB::table('servers')->insertGetId($other);
    DB::table('allocations')->where('id', $otherAllocation)->update(['server_id' => $otherServer]);
});
