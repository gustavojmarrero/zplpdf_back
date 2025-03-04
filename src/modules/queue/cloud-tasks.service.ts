import { Injectable, Logger, Inject } from '@nestjs/common';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CloudTasksService {
  private tasksClient: CloudTasksClient;
  private readonly logger = new Logger(CloudTasksService.name);
  private readonly projectId: string;
  private readonly location: string;
  private readonly queueName: string;
  private readonly serviceAccountEmail: string;

  constructor(
    private configService: ConfigService,
    @Inject('GOOGLE_AUTH_OPTIONS') private googleAuthOptions: any,
  ) {
    this.projectId = this.configService.get<string>('GCP_PROJECT_ID');
    this.location = this.configService.get<string>('GCP_LOCATION');
    this.queueName = this.configService.get<string>('GCP_QUEUE_NAME');
    this.serviceAccountEmail = this.configService.get<string>(
      'GCP_SERVICE_ACCOUNT_EMAIL',
    );

    this.tasksClient = new CloudTasksClient(this.googleAuthOptions);
  }

  async enqueueZplConversionTask(
    zplContent: string,
    labelSize: string,
    jobId: string,
    language: string,
  ): Promise<string> {
    const parent = this.tasksClient.queuePath(
      this.projectId,
      this.location,
      this.queueName,
    );

    const task: protos.google.cloud.tasks.v2.ITask = {
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.configService.get<string>('SERVICE_URL')}/api/zpl/process`,
        oidcToken: {
          serviceAccountEmail: this.serviceAccountEmail,
        },
        body: Buffer.from(
          JSON.stringify({
            zplContent,
            labelSize,
            jobId,
            language,
          }),
        ).toString('base64'),
        headers: {
          'Content-Type': 'application/json',
        },
      },
      name: `${parent}/tasks/${jobId}`,
    };

    const [response] = await this.tasksClient.createTask({ parent, task });
    this.logger.log(`Tarea creada: ${response.name}`);
    return response.name;
  }
}
