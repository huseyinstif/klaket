import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export class Klaket implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Klaket',
		name: 'klaket',
		icon: 'file:klaket.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Turn any video into LLM-ready data: transcripts, speakers, scenes, OCR, chapters and moment search',
		defaults: { name: 'Klaket' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'klaketApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'ingestAndWait',
				options: [
					{ name: 'Ingest & Wait', value: 'ingestAndWait', action: 'Process a video and wait for the result', description: 'Queue a video and wait until the LLM-ready result is available' },
					{ name: 'Ingest', value: 'ingest', action: 'Queue a video', description: 'Queue a video for processing and return the job ID immediately' },
					{ name: 'Get Job Status', value: 'getStatus', action: 'Get job status', description: 'Check the progress of a job' },
					{ name: 'Get Result', value: 'getResult', action: 'Get the result', description: 'Fetch the LLM-ready result of a completed job' },
					{ name: 'Find Moment', value: 'findMoment', action: 'Find a moment in a video', description: 'Search inside a processed video for the moment something is said or shown' },
				],
			},
			// --- ingest fields ---
			{
				displayName: 'Video URL or Path',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://youtube.com/watch?v=...',
				description: 'Video/audio URL (e.g. YouTube) or a worker-visible file path',
				displayOptions: { show: { operation: ['ingest', 'ingestAndWait'] } },
			},
			{
				displayName: 'Options',
				name: 'ingestOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['ingest', 'ingestAndWait'] } },
				options: [
					{ displayName: 'Language', name: 'language', type: 'string', default: 'auto', description: 'ISO 639-1 hint, or "auto"' },
					{ displayName: 'Model', name: 'model', type: 'options', default: 'small', options: [
						{ name: 'Tiny', value: 'tiny' },
						{ name: 'Base', value: 'base' },
						{ name: 'Small', value: 'small' },
						{ name: 'Medium', value: 'medium' },
						{ name: 'Large-v3', value: 'large-v3' },
					], description: 'Whisper model for this job' },
					{ displayName: 'Context Prompt', name: 'prompt', type: 'string', default: '', description: 'Proper nouns / jargon hint (max 500 chars)' },
					{ displayName: 'Number of Speakers', name: 'numSpeakers', type: 'number', default: 0, description: 'Diarization hint, 0 = auto' },
					{ displayName: 'Translate To', name: 'translateTo', type: 'string', default: '', description: 'ISO 639-1 language to translate the transcript into (local, keyless)' },
					{ displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '', description: 'POSTed when the job finishes or fails' },
				],
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				default: 1800,
				description: 'Max time to wait for the job to finish',
				displayOptions: { show: { operation: ['ingestAndWait'] } },
			},
			// --- job id fields ---
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { operation: ['getStatus', 'getResult', 'findMoment'] } },
			},
			// --- search fields ---
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'docker compose command',
				description: 'What to look for inside the video',
				displayOptions: { show: { operation: ['findMoment'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('klaketApi');
		const baseUrl = (credentials.apiUrl as string).replace(/\/$/, '');
		const apiKey = credentials.apiKey as string;

		const request = async (method: 'GET' | 'POST', path: string, body?: IDataObject) => {
			const options: IHttpRequestOptions = {
				method,
				url: `${baseUrl}${path}`,
				json: true,
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			};
			if (body) options.body = body;
			try {
				return await this.helpers.httpRequest(options);
			} catch (error) {
				throw new NodeApiError(this.getNode(), error as never);
			}
		};

		const buildIngestBody = (i: number): IDataObject => {
			const body: IDataObject = { url: this.getNodeParameter('url', i) as string };
			const opts = this.getNodeParameter('ingestOptions', i, {}) as IDataObject;
			if (opts.language) body.language = opts.language;
			if (opts.model) body.model = opts.model;
			if (opts.prompt) body.prompt = opts.prompt;
			if (opts.numSpeakers) body.num_speakers = opts.numSpeakers;
			if (opts.translateTo) body.translate_to = opts.translateTo;
			if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
			return body;
		};

		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let responseData: IDataObject;

				if (operation === 'ingest') {
					responseData = (await request('POST', '/v1/ingest', buildIngestBody(i))) as IDataObject;
				} else if (operation === 'ingestAndWait') {
					const queued = (await request('POST', '/v1/ingest', buildIngestBody(i))) as IDataObject;
					const jobId = queued.id as string;
					const timeout = (this.getNodeParameter('timeout', i) as number) * 1000;
					const deadline = Date.now() + timeout;
					for (;;) {
						const job = (await request('GET', `/v1/jobs/${jobId}`)) as IDataObject;
						if (job.status === 'done') break;
						if (job.status === 'failed') {
							throw new NodeOperationError(this.getNode(), `Klaket job ${jobId} failed: ${job.error}`, { itemIndex: i });
						}
						if (Date.now() > deadline) {
							throw new NodeOperationError(this.getNode(), `Klaket job ${jobId} timed out`, { itemIndex: i });
						}
						await sleep(3000);
					}
					responseData = (await request('GET', `/v1/jobs/${jobId}/result`)) as IDataObject;
				} else if (operation === 'getStatus') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					responseData = (await request('GET', `/v1/jobs/${jobId}`)) as IDataObject;
				} else if (operation === 'getResult') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					responseData = (await request('GET', `/v1/jobs/${jobId}/result`)) as IDataObject;
				} else if (operation === 'findMoment') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					const query = this.getNodeParameter('query', i) as string;
					responseData = (await request('GET', `/v1/jobs/${jobId}/search?q=${encodeURIComponent(query)}`)) as IDataObject;
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, { itemIndex: i });
				}

				returnData.push({ json: responseData, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
