import { GetAllCertificatesQuery, GetCertificateQuery } from '@energyweb/issuer-api';
import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { InjectQueue } from '@nestjs/bull';
import { IClaim } from '@energyweb/issuer';
import { Queue } from 'bull';
import {
    ICertificate,
    IClaimCommand,
    IIssueCommand,
    ITransferCommand,
    ISuccessResponse,
    BlockchainActionType,
    BlockchainAction,
    IIssuedCertificate,
    IIssueCommandParams
} from './types';

const jobOptions = {
    // redis cleanup
    removeOnComplete: true,
    removeOnFail: true
};

@Injectable()
export class CertificateService<T = null> {
    constructor(
        private readonly queryBus: QueryBus,
        @InjectQueue('blockchain-actions')
        private readonly blockchainActionsQueue: Queue<BlockchainAction>
    ) {}

    public async getAll(): Promise<ICertificate<T>[]> {
        const certificates = await this.queryBus.execute(new GetAllCertificatesQuery());

        return certificates.map((c) => this.mapCertificate(c));
    }

    public async getById(id: number): Promise<ICertificate<T> | null> {
        const certificate = await this.queryBus.execute(new GetCertificateQuery(id));

        return certificate ? this.mapCertificate(certificate) : null;
    }

    public async issue(params: IIssueCommandParams<T>): Promise<IIssuedCertificate<T>> {
        const command = {
            ...params,
            fromTime: Math.round(params.fromTime.getTime() / 1000),
            toTime: Math.round(params.toTime.getTime() / 1000)
        } as IIssueCommand<T>;

        const job = await this.blockchainActionsQueue.add(
            {
                payload: command,
                type: BlockchainActionType.Issuance
            },
            jobOptions
        );

        const result = await job.finished();

        return this.mapCertificate(result);
    }

    public async claim(command: IClaimCommand): Promise<ISuccessResponse> {
        const job = await this.blockchainActionsQueue.add(
            {
                payload: command,
                type: BlockchainActionType.Claim
            },
            jobOptions
        );

        const result = await job.finished();

        return result;
    }

    public async transfer(command: ITransferCommand): Promise<ISuccessResponse> {
        const job = await this.blockchainActionsQueue.add(
            {
                payload: command,
                type: BlockchainActionType.Transfer
            },
            jobOptions
        );

        const result = await job.finished();

        return result;
    }

    private mapCertificate<P extends { metadata: any; claims: IClaim[] }>(
        certificate: P
    ): P & { metadata: T; claims: IClaim[] } {
        return {
            ...certificate,
            /** @NOTE this may be null, but this will be fixed at some point */
            claims: certificate.claims ?? [],
            metadata: certificate.metadata !== '' ? JSON.parse(certificate.metadata) : null
        };
    }
}
