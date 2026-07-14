import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KlaketApi implements ICredentialType {
	name = 'klaketApi';

	displayName = 'Klaket API';

	documentationUrl = 'https://github.com/huseyinstif/klaket/blob/main/docs/api.md';

	properties: INodeProperties[] = [
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: 'http://localhost:8484',
			placeholder: 'http://localhost:8484',
			description: 'Base URL of your self-hosted Klaket API (docker compose up in the Klaket repo)',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Only needed for authenticated deployments (KLAKET_AUTH=on). Leave empty for local self-hosting.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{ $credentials.apiKey ? "Bearer " + $credentials.apiKey : undefined }}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.apiUrl }}',
			url: '/healthz',
		},
	};
}
