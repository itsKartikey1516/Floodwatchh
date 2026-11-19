(() => {
  const $ = id => document.getElementById(id);
  if (!$('atlasSmsRegister')) return;
  let matches = [], timer, searchSequence = 0, pendingPhone = '', configured = false;
  const status = (message, tone = '') => {
    $('atlasSmsStatus').textContent = message;
    $('atlasSmsStatus').className = 'sms-service-status ' + tone;
  };
  async function request(url, body) {
    const response = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(25000), ...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'SMS service unavailable. Please retry.');
    return data;
  }
  request('/api/sms/status').then(data => {
    configured = data.configured === true;
    $('atlasSmsFields').disabled = !configured;
    status(configured ? 'Verify your number to start receiving district flood watches.' : 'SMS registration is not available yet. Delivery setup is pending; no phone numbers are being registered.');
  }).catch(() => status('SMS service is unavailable. Please refresh to try again.', 'error'));
  $('smsDistrictQuery').addEventListener('input', () => {
    clearTimeout(timer); const sequence = ++searchSequence;
    matches = []; $('smsDistrictChoice').replaceChildren(new Option('Choose a matching district', ''));
    const q = $('smsDistrictQuery').value.trim();
    if (q.length < 2) { $('smsDistrictHint').textContent = 'Type at least two letters.'; return; }
    timer = setTimeout(async () => {
      try {
        const data = await request('/api/atlas/districts?' + new URLSearchParams({q}));
        if (sequence !== searchSequence) return;
        matches = data.results;
        matches.forEach((a,i) => $('smsDistrictChoice').add(new Option(a.district + ', ' + a.state, String(i))));
        if (matches.length === 1) $('smsDistrictChoice').value = '0';
        $('smsDistrictHint').textContent = matches.length ? (data.truncated ? 'More matches available. Add your state to narrow the search.' : 'Choose the district you want to monitor.') : 'No covered district found. Try its atlas name or state.';
      } catch { if (sequence === searchSequence) $('smsDistrictHint').textContent = 'District search is unavailable. Please retry.'; }
    },350);
  });
  $('atlasSmsRegister').addEventListener('submit', async event => {
    event.preventDefault(); if (!configured) return;
    const choice = $('smsDistrictChoice').value;
    const area = choice !== '' && matches[Number(choice)];
    if (!area) { status('Choose a district from the search results.', 'error'); return; }
    let phone = $('atlasSmsPhone').value.replace(/[\s()-]/g, '');
    if (/^[6-9]\d{9}$/.test(phone)) phone = '+91' + phone;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) { status('Include your country code, for example +91 followed by your mobile number.', 'error'); return; }
    $('atlasSmsSend').disabled = true; status('Requesting your verification code…');
    try {
      await request('/api/sms/subscribe',{phone,district:area.district,state:area.state,consent:$('atlasSmsConsent').checked});
      pendingPhone = phone;
      $('atlasSmsRegister').hidden = true; $('atlasSmsVerify').hidden = false;
      $('atlasSmsCodeHint').textContent = 'Enter the code sent to the number ending ' + phone.slice(-4) + '. It expires in 10 minutes.';
      status('Verification code requested. Delivery can take a moment.'); $('atlasSmsCode').focus();
    } catch (error) { status(error.message, 'error'); }
    finally { $('atlasSmsSend').disabled = false; }
  });
  $('atlasSmsVerify').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('atlasSmsVerify').querySelector('[type=submit]');
    button.disabled = true;
    try {
      const result = await request('/api/sms/verify',{phone:pendingPhone,code:$('atlasSmsCode').value.trim()});
      $('atlasSmsVerify').hidden = true; $('atlasSmsSuccess').hidden = false;
      $('atlasSmsSuccessText').textContent = result.message;
      const link = $('atlasSmsUnsubscribe'); link.hidden = !result.unsubscribeUrl;
      if (result.unsubscribeUrl) link.href = result.unsubscribeUrl;
      $('atlasSmsCode').value = ''; $('atlasSmsPhone').value = ''; pendingPhone = '';
      status('Registration complete. New high or elevated watches will be sent to your phone.', 'success');
    } catch (error) { status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('atlasSmsEdit').onclick = () => {
    $('atlasSmsVerify').hidden = true; $('atlasSmsRegister').hidden = false; $('atlasSmsCode').value = '';
    status('Update your details or request another code. Allow one minute between requests.');
  };
  $('atlasSmsAnother').onclick = () => {
    $('atlasSmsSuccess').hidden = true; $('atlasSmsRegister').hidden = false;
    $('atlasSmsConsent').checked = false; status('Verify your number to start receiving district flood watches.');
  };
})();
