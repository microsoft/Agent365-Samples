const form = document.querySelector('#connect-form');
const button = document.querySelector('#connect-button');
const stages = [...document.querySelectorAll('#stages li')];

async function refreshStatus() {
  const status = await fetch('/api/3p/status').then(response => response.json());
  document.querySelector('#connections').textContent = status.connections;
  document.querySelector('#agents').textContent = status.registryAgents;
  document.querySelector('#telemetry').textContent = status.telemetryRecords;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  stages.forEach(stage => stage.classList.remove('done'));
  document.querySelector('#system-status').textContent = 'Connection workflow running';
  document.querySelector('#run-copy').textContent = 'Creating the provider connection…';
  try {
    const response = await fetch('/api/3p/connections', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({provider: form.provider.value, name: form.name.value})
    });
    if (!response.ok) throw new Error((await response.json()).detail ?? 'Connection failed');
    const result = await response.json();
    stages.forEach(stage => stage.classList.add('done'));
    document.querySelector('#run-copy').textContent = `${result.discoveredAgents} agents imported; ${result.telemetry.records_exported} telemetry records exported.`;
    document.querySelector('#system-status').textContent = 'Telemetry synchronized';
    document.querySelector('#agent-rows').innerHTML = result.importedAgents.map(agent => `
      <tr><td>${agent.provider_agent_id}</td><td>${agent.observability_id}</td><td class="state">Synchronized</td></tr>
    `).join('');
    await refreshStatus();
  } catch (error) {
    document.querySelector('#run-copy').textContent = error.message;
    document.querySelector('#system-status').textContent = 'Connection failed';
  } finally {
    button.disabled = false;
  }
});

refreshStatus();