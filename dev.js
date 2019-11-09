const https = require('https');
const express = require('express');
const client = require('twilio');
const VoiceResponse = client.twiml.VoiceResponse;
const urlencoded = require('body-parser').urlencoded;
const moment = require('moment-timezone');
const morgan = require('morgan');

const airtableId = process.env.AIRTABLE_ID;

const base = require('airtable').base(airtableId);

const app = express();


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const bucketId = process.env.KVDB_BUCKETID;

// Mini lib for http calls
function std_callback(resolve, reject) {
  return (response) => {
    let chunks_of_data = [];

    response.on('data', (fragments) => {
      chunks_of_data.push(fragments);
    });

    response.on('end', () => {
      let response_body = Buffer.concat(chunks_of_data);
      if (response.statusCode >= 400) {
        reject(response_body.toString());
      } else {
        resolve(response_body.toString());
      }
    });

    response.on('error', (error) => {
      reject(error);
    });
  };
}

function https_get_promise(url) {
  return new Promise((res, rej) => {
      https.get(url, std_callback(res, rej));
  });
}

function https_req_promise(method, host, path, type, body, hd) {
  return new Promise((res, rej) => {
      let c = {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body)
      };
      let r = https.request({
        hostname: host,
        port: 443,
        path: path,
        method: method,
        headers: {...hd, ...c}
      }, std_callback(res, rej));
      r.write(body);
      r.end();
  });
}
//--

function getKey(k) {
	return https_get_promise('https://kvdb.io/' + bucketId + '/' + k);
}

function setKey(k, v) {
	return https_req_promise('PUT', 'kvdb.io', '/' + bucketId + '/' + k,
		'text/plain', v);
}

function addCounter(k) {
	return https_req_promise('PATCH', 'kvdb.io', '/' + bucketId + '/' + k,
		'text/plain', '+1');
}

//--
function sendRes(res, twiml) {
  // Render the response as XML in reply to the webhook request
  res.type('text/xml');
  res.send(twiml.toString());
}

// Parse incoming POST params with Express middleware
app.use(urlencoded({ extended: false }));

// Add logging
app.use(morgan('dev'));



//Validate signature
if (process.env.PROD) {
	app.use(function(req, res, next) {
		var fullUrl = 'https' + '://' + req.get('host') + req.originalUrl;
		const params = req.body;
		const signature = req.headers['x-twilio-signature'];
		console.log('[DEBUG] URL:' + fullUrl + ' sig:' + signature);

		if (client.validateRequest(authToken, signature, fullUrl, params)) {
			next();
		} else {
			console.log('[ERROR] Request Authen failed');
			res.type('text/plain');
			res.send('Error: Request Authen failed.');
		}
	});
}

// Custom session using kvdb.io
app.use(async function(req, res, next) {
	let cid = req.body.CallSid;
	console.log('[INFO] CallSid = ' + cid);
	try {
	  //if (req.body.LangPref) {
	  //  await setKey(cid + ':langpref', req.body.LangPref);
	  //} else {
			let langpref = await getKey(cid + ':langpref');
	    req.body.LangPref = langpref;
	  //}
	} catch (err) {
		console.log('[WARN] - LangPref: ' + err);
		if (!req.body.LangPref) { req.body.LangPref = '1'; }
	}
  next();
});


function getCurrentHour() {
	return moment().tz("Asia/Hong_Kong").hour();
}

app.post('/landing', (req, res) => {
	const twiml = new VoiceResponse();

	let h = getCurrentHour();
	let greeting = {};
	if (h < 6) {
	  greeting['en-US'] = 'Greetings.';
		greeting['zh-HK'] = '你好.';
	} else if (h < 12) {
		greeting['en-US'] = 'Good morning.';
		greeting['zh-HK'] = '早晨.';
	} else if (h < 19) {
		greeting['en-US'] = 'Good afternoon.';
		greeting['zh-HK'] = '午安.';
	} else {
		greeting['en-US'] = 'Good evening.';
		greeting['zh-HK'] = '晩安.';
	}
	twiml.say(greeting['en-US'] + ' ' + 'Welcome to Fake Bank.');
	twiml.say({
		voice: 'alice',
		language: 'zh-HK'
	}, greeting['zh-HK'] + ' ' + '歡迎使用假銀行.')
	twiml.pause({ length: 2 });
	twiml.redirect('/choose_lang');

	sendRes(res, twiml);
});

function handleMenuChoice(digit, tree_root, handlers, err_handler) {
	let matched = false;
	if (digit) {
		let h = handlers[digit];
		if (h) {
			h(digit, tree_root);
			matched = true;
		} else {
			err_handler(tree_root);
		}
	}
	return matched;
}

function jump(url) {
	return (digit, tree_root) => {
		tree_root.redirect(url);
	};
}
function please_enter_again(l) {
	if (l == 2) {
		return (tree_root) => {
			tree_root.say({
				voice: 'alice',
				language: 'zh-HK'
			}, '輸入錯誤, 請重新輸入.');
			tree_root.pause({ length: 1 });
		}
	} else {
		return (tree_root) => {
			tree_root.say('Invalid input, please try again.');
			tree_root.pause({ length: 1 });
		}
	}
}

app.post('/choose_lang', async (req, res) => {
	const twiml = new VoiceResponse();

	let set_lang_pref = async (digit, twiml) => {
		let cid = req.body.CallSid;
		console.log('[INFO] cid:' + cid + ' lang:' + digit);
		await setKey(cid + ':langpref', digit);
		twiml.redirect('/menu');
		sendRes(res, twiml);
	};
	let cont = !handleMenuChoice(req.body.Digits, twiml,
		{ '1': set_lang_pref, '2': set_lang_pref },
		(twiml) => {
			twiml.say('Please select a language.');
			twiml.say({
				voice: 'alice',
				language: 'zh-HK'
			}, '請選擇語言.');
			twiml.pause({ length: 1 });
		});

	if (cont) {
		const gather = twiml.gather({
			numDigits: 1,
			action: '/choose_lang'
		});
		gather.say('For English, press 1.');
		gather.say({
			voice: 'alice',
			language: 'zh-HK'
		}, '廣東話, 請按二字.');
		twiml.redirect('/choose_lang');
		sendRes(res, twiml);
	}

});

const lang_map = ['en-US', 'zh-HK'];

const say_opt = {
	'en-US': {},
	'zh-HK': {
		voice: 'alice',
		language: 'zh-HK'
	}
};

const menu_header = {
	'en-US': 'Please select a service:',
	'zh-HK': '請選擇服務:'
};

const menu_item = [
	{ 'en-US': 'To enquiry account balance', 'zh-HK': '查詢戶口結餘' },
	{ 'en-US': 'For fund transfer', 'zh-HK': '轉帳服務' },
	{ 'en-US': 'To change language preference', 'zh-HK': '選擇語言' },
	{ 'en-US': 'To contact our Customer Service representative', 'zh-HK': '聯絡我們的客戶服務主任' }
];

const menu_say = {
	'en-US': (action, digit) => `${action}, press ${digit}.`,
	'zh-HK': (action, digit) => `${action}, 按${digit}字.`
};

function say_a_menu(tree, target, header, items, l) {
	const gather = tree.gather({
		numDigits: 1,
		action: target
	});
	if (header) {
		intl_say(gather, l, select_lang(header, l));
	}
	let fmt = select_lang(menu_say, l);

	for (i = 0; i < items.length; i++) {
		let item = items[i];
		let k = ('key' in item) ? item['key'] : (i+1);
		//let k = item['key'];
		intl_say(gather, l, fmt(select_lang(item, l), k));
	}
}

function select_lang(itm, l) {
	return itm[lang_map[l-1]];
}

function intl_say(tree, l, body) {
	let l_opt = select_lang(say_opt, l);
	return tree.say(l_opt, body);
}

app.post('/menu', (req, res) => {
  const twiml = new VoiceResponse();
	let l = req.body.LangPref;

	let cont = !handleMenuChoice(req.body.Digits, twiml,
		{
			'1': jump('/prompt_accid/enquiry_balance'),
			'2': jump('/prompt_accid/fund_transfer/select_type'),
			'3': jump('/choose_lang'),
			'4': jump('/contact_csr')
		},
		please_enter_again(l));

	if (cont) {
		say_a_menu(twiml, '/menu', menu_header, menu_item, l);
		twiml.redirect('/menu');
	}

	sendRes(res, twiml);
});

/*
const gather = twiml.gather({
	numDigits: 1,
	action: '/menu'
});
intl_say(gather, l, select_lang(menu_header, l));
let fmt = select_lang(menu_say, l);

for (i = 0; i < menu_item.length; i++) {
	intl_say(gather, l, fmt(select_lang(menu_item[i], l), i+1));
}
twiml.redirect('/menu');
*/

/*
prompt_accid -> loop if idle
|
v
prompt_check:
 - empty -> cancel
 - incomplete/wrong format -> err -> prompt_accid
 - acc not exist -> err -> prompt_accid
 - ok -> save session var -> prompt_pin

prompt_pin -> loop if idle
|
v
prompt_pin_check:
 - empty -> cancel
 - incomplete/incorrect pwd -> inc err cnt
   - retries left: err -> prompt_pin
	 - no retries left: err -> exit
 - ok -> exit
*/

function airtable_err(res, l) {
	return (err) => {
		if (!err) { return; }
		console.log('[WARN] Airtable error: ' + err);

		const twiml = new VoiceResponse();
		intl_say(twiml, l, select_lang(auth_err['system_err'], l));
		twiml.redirect('/menu');

		sendRes(res, twiml);
	}
}

function validate_numeric(input, no_digits) {
	return (input.length == no_digits) && /^\d+$/.test(input);
}

const prompt_account_id = {
	'en-US': 'Please enter the 13 digits account ID. To cancel, press star.',
	'zh-HK': '請輸入十三位數字的戶口編號, 取消輸入, 按星字.'
}

const prompt_pin = {
	'en-US': 'Please enter the 6 digits PIN number. To cancel, press star.',
	'zh-HK': '請輸入六位數字的戶口密碼, 取消輸入, 按星字.'
}

const auth_err = {
	'system_err': {
		'en-US': 'Sorry, there is a system error.',
		'zh-HK': '對不起, 系統錯誤.'
	},
	'incorrect': {
		'en-US': 'Incorrect. Please try again.',
		'zh-HK': '輸入錯誤, 請重新輸入.'
	},
	'account_not_found': {
		'en-US': 'The account you have entered does not exist.',
		'zh-HK': '你所輸入的戶口號碼並不存在'
	},
	'pwd_incorrect_retry': {
		'en-US': 'The PIN you have entered is incorrect, please try again.',
		'zh-HK': '你所輸入的密碼並不正確, 請重新輸入.'
	},
	'pwd_incorrect_stop': {
		'en-US': 'Sorry, the PIN you have entered is incorrect.',
		'zh-HK': '對不起, 你所輸入的密碼並不正確.'
	}
}

app.post('/prompt_accid/:fn', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let fn = req.params['fn'];

	const gather = twiml.gather({
		numDigits: 13,
		finishOnKey: '*',
		action: '/prompt_accid/check/' + fn
	});
	intl_say(gather, l, select_lang(prompt_account_id, l));
	twiml.redirect('/prompt_accid/' + fn);

	sendRes(res, twiml);
});

app.post('/prompt_accid/check/:fn', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let fn = req.params['fn'];

	let acc_id = req.body.Digits;
	if (!acc_id || acc_id === '') {
		twiml.redirect('/menu');
		sendRes(res, twiml);
	} else if (!validate_numeric(acc_id, 13)) {
		intl_say(twiml, l, select_lang(auth_err['incorrect'], l));
		twiml.redirect('/prompt_accid/' + fn);
		sendRes(res, twiml);
	} else {
		let cid = req.body.CallSid;
		let accId_fmt = [acc_id.slice(0, 3), acc_id.slice(3, 10), acc_id.slice(10)].join('-');
		console.log('[DEBUG] acc_id=' + acc_id + ', accId_fmt=' + accId_fmt);

		base('Accounts').select({
	    maxRecords: 1,
	    view: "Grid view",
			fields: ["Account ID", "PIN", "Account Balance", "Owner ID"],
			filterByFormula: "{Account ID} = '" + accId_fmt + "'"
		}).eachPage(async (records, next) => {
			if (!records || records.length == 0) {
				console.log('[TRACE] records:' + records);
				console.log('[DEBUG] Account not found: ' + accId_fmt);
				intl_say(twiml, l, select_lang(auth_err['account_not_found'], l));
				twiml.redirect('/prompt_accid/' + fn);
				sendRes(res, twiml);
			} else {
				let record = records[0];
				let fmt_acc_id = record.get('Account ID');
				let pin = record.get('PIN')[0];
				let balance = record.get('Account Balance');
				let owner = record.get('Owner ID')[0];

				console.log('[DEBUG] acc:', fmt_acc_id, ', pin:', pin, ', balance:', balance, ', owner:', owner);

				await setKey(cid + ':auth_acc', [fmt_acc_id, pin, balance, owner].join('|'));

				twiml.redirect('/prompt_pin/' + fn);
				sendRes(res, twiml);
			}
			next();
		}, airtable_err(res, l));
	}
});

app.post('/prompt_pin/:fn', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let fn = req.params['fn'];

	const gather = twiml.gather({
		numDigits: 6,
		finishOnKey: '*',
		action: '/prompt_pin/check/' + fn
	});
	intl_say(gather, l, select_lang(prompt_pin, l));
	twiml.redirect('/prompt_pin/' + fn);

	sendRes(res, twiml);
});

app.post('/prompt_pin/check/:fn', async (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let fn = req.params['fn'];

	let pin = req.body.Digits;
	if (!pin || pin == '') {
		twiml.redirect('/menu');
		sendRes(res, twiml);
	} else {
		let cid = req.body.CallSid;
		let auth = await getKey(cid + ':auth_acc');
		console.log('[TRACE] auth=' + auth);

		let [acc, pin_answer, balance] = auth.split('|');
		if (pin === pin_answer) {
			await setKey(cid + ':err_cnt', '0');
			twiml.redirect(fn);
			sendRes(res, twiml);
		} else {
			let err_cnt = await addCounter(cid + ':err_cnt');
			let err_cnt_parsed = Number.parseInt(err_cnt, 10);

			if (err_cnt_parsed < 3) {
				intl_say(twiml, l, select_lang(auth_err['pwd_incorrect_retry'], l));
				twiml.redirect('/prompt_pin/' + fn);
				sendRes(res, twiml);
			} else {
				intl_say(twiml, l, select_lang(auth_err['pwd_incorrect_stop'], l));
				twiml.hangup();
				sendRes(res, twiml);
			}
		}
	}
});

/* Feature: Enquiry Balance */
const balance_answer = {
	'en-US': (balance) => `Your account balance is \$${balance}.`,
	'zh-HK': (balance) => `你的戶口結餘為: \$${balance}.`
}

const enquiry_followup = [
	{
		'en-US': 'To enquiry another account',
		'zh-HK': '查詢其它戶口',
		'key': 1
	},
	{
		'en-US': 'To transfer fund from this account',
		'zh-HK': '由本戶口進行轉賬',
		'key': 2
	},
	{
		'en-US': 'To go back to main menu',
		'zh-HK': '返回主目錄',
		'key': 0
	}
]

app.post('/enquiry_balance', async (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let cid = req.body.CallSid;

	let acc = await getKey(cid + ':auth_acc');
	let balance = acc.split('|')[2];
	let fmt = select_lang(balance_answer, l);

	intl_say(twiml, l, fmt(balance));
	twiml.redirect('/enquiry_balance/followup');

	sendRes(res, twiml);
});

app.post('/enquiry_balance/followup', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;

	let cont = !handleMenuChoice(req.body.Digits, twiml,
		{
			'1': jump('/prompt_accid/enquiry_balance'),
			'2': jump('/fund_transfer/select_type'),
			'0': jump('/menu')
		},
		please_enter_again(l));

	if (cont) {
		say_a_menu(twiml, '/enquiry_balance/followup', null, enquiry_followup, l);
		twiml.redirect('/enquiry_balance/followup');
	}
	sendRes(res, twiml);
});

/* Feature: Transfer Fund */
const abort_op = {
	'en-US': 'To abort operation and go back to the main menu',
	'zh-HK': '取消操作並返回主目錄',
	'key': '0'
};
const last_step = {
	'en-US': 'To go back to the last step',
	'zh-HK': '返回上一步',
	'key': '9'
};

const select_type_menu = [
	{
		'en-US': 'To transfer fund to your own accounts',
		'zh-HK': '轉賬至同名戶口',
		'key': '1'
	},
	{
		'en-US': 'To transfer fund to pre-registered accounts in this bank',
		'zh-HK': '轉賬至本行登記賬戶',
		'key': '2'
	},
	abort_op
];

const no_account = {
	'en-US': 'Sorry, no accounts available.',
	'zh-HK': '對不起, 找不到可供轉賬的戶口.'
};

app.post('/fund_transfer/select_type', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;

	say_a_menu(twiml, '/fund_transfer/select_account', null, select_type_menu, l);
	twiml.redirect('/fund_transfer/select_account');
	sendRes(res, twiml);
});

const choose_acc_prompt = {
	'en-US': 'Select an account below:',
	'zh-HK': '請選擇戶口編號:'
};

app.post('/fund_transfer/select_account', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let cid = req.body.CallSid;

	async function list_acc(d, tree) {
		let acc = await getKey(cid + ':auth_acc');
		let current_acc = acc.split('|')[0];
		let user_rawid = acc.split('|')[3];
		base('Users').find(user_rawid, (err, record) => {
			if (err) {
				console.error(err);
				intl_say(twiml, l, select_lang(auth_err['system_err'], l));
				twiml.redirect('/menu');
				sendRes(res, twiml);
			}
			let own_accounts = record.get('Accounts');
			var allowed_accounts = record.get('Allowed Transfer Account');
			if ((typeof(allowed_accounts) === 'undefined') || (allowed_accounts === null)) {
				allowed_accounts = [];
			}

			const queryBuilder = (rid) => `RECORD_ID() = '${rid}'`;
			let query = "OR( " + own_accounts.concat(allowed_accounts).map(queryBuilder).join(',') + " )";

			base('Accounts').select({
				filterByFormula: query,
				maxRecords: 5,
    		view: "Grid view",
				fields: ["Account ID"]
			}).eachPage(async (records, next) => {
				var own_accounts_mapping = [];
				var allowed_accounts_mapping = [];
				records.forEach(function(record) {
					let accId = record.get("Account ID");
        	console.log('[TRACE] DB record - id:', record.id, ', Account ID:', accId);
					if (current_acc == accId) return;

					if (own_accounts.includes(record.id)) {
						own_accounts_mapping.push([record.id, accId]);
					} else {
						allowed_accounts_mapping.push([record.id, accId]);
					}
    		});
				let data1 = own_accounts_mapping
					.map((x) => { return "(" + x[0] + "," + x[1] + ")"; })
					.join(',');
				let data2 = allowed_accounts_mapping
					.map((x) => { return "(" + x[0] + "," + x[1] + ")"; })
					.join(',');
				await setKey(cid + ':acc_details', data1 + '|' + data2);

				//intl_say(tree, l, select_lang(choose_acc_prompt, l));
				switch(d) {
					case '1':
							if (own_accounts_mapping.length == 0) {
								say_a_menu(twiml, '/fund_transfer/enter_amount', no_account,
									[last_step, abort_op], l);
							} else {
								say_a_menu(twiml, '/fund_transfer/enter_amount', choose_acc_prompt,
									own_accounts_mapping.map((acc) =>{
										return { 'en-US': acc[1], 'zh-HK': acc[1] };
									}).push(last_step).push(abort_op)
									,l);
							}
						break;
					case '2':
							if (allowed_accounts_mapping.length == 0) {
								say_a_menu(twiml, '/fund_transfer/enter_amount', no_account,
									[last_step, abort_op], l);
							} else {
								say_a_menu(twiml, '/fund_transfer/enter_amount', choose_acc_prompt,
									allowed_accounts_mapping.map((acc) =>{
										return { 'en-US': acc[1], 'zh-HK': acc[1] };
									}).push(last_step).push(abort_op)
									,l);
							}
						break;
					default:
				}
				twiml.redirect('/fund_transfer/enter_amount');
				sendRes(res, twiml);

				next();
			}, airtable_err(res));
		});
	}

	let cont = handleMenuChoice(req.body.Digits, twiml,
		{
			'1': list_acc,
			'2': list_acc,
			'0': (d, tree) => {
				tree.redirect('/menu');
				sendRes(res, tree);
			}
		},
		please_enter_again(l));
	if (!cont) {
		twiml.redirect('/fund_transfer/select_type');
		sendRes(res, twiml);
	}
});





/* Feature: Contact CSR */

const enqueue_prompt = {
	'en-US': '',
	'zh-HK': ''
};

const explain_cant_contact = {
	'timeout': {
		'en-US': ''
	},
	'not_in_service': {}
};

app.post('/contact_csr', async (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let cid = req.body.CallSid;

	let service_status = await getKey('call_centre_service_status');
	if (service_status == 'in_service') {
		intl_say(twiml, l, select_lang(enqueue_prompt, l));
		twiml.enqueue({
			waitUrl: '/contact_csr/waiting',
			//
		}, 'support');
		twiml.leave('support');
		twiml.redirect('/contact_csr/voice_mail/timeout');
	} else {
		twiml.redirect('/contact_csr/voice_mail/not_in_service');
	}
	sendRes(res, twiml);
});

app.post('/contact_csr/waiting', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let cid = req.body.CallSid;

	twiml.play({ loop: 3 }, 'url');

	twiml.redirect('/contact_csr/waiting');

	sendRes(res, twiml);
});

app.post('/contact_csr/voice_mail/:reason', (req, res) => {
	const twiml = new VoiceResponse();
	let l = req.body.LangPref;
	let cid = req.body.CallSid;

	intl_say(twiml, l, select_lang(explain_cant_contact[req.params['reason']], l));
	twiml.pause({ length: 1 });

	//
});

app.post('/contact_csr/connect', (req, res) => {
	//
	const twiml = new VoiceResponse();
	const dial = twiml.dial();
	dial.sip({
		'username': '',
		'password': '',
		statusCallbackEvent: 'initiated ringing answered completed',
    statusCallback: 'https://myapp.com/calls/events',
    statusCallbackMethod: 'POST',
		//
	}, 'sip:kate@example.com');
});

app.post('/contact_csr/followup', (req, res) => {
	//
});

//--

// Create an HTTP server and listen for requests on port 3000
console.log('Twilio Client app HTTP server running at http://127.0.0.1:3000');
app.listen(3000);
