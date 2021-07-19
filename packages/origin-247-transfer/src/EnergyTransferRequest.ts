export enum TransferValidationStatus {
    Pending = 'pending',
    Valid = 'valid',
    Invalid = 'invalid',
    Error = 'error'
}

export interface IUpdateStatusResult {
    success: boolean;
    message?: string;
}

export enum UpdateStatusCode {
    Success = 'success',
    NoValidator = 'noValidator',
    NotPending = 'notPending'
}

export interface EnergyTransferRequestPublicAttrs {
    id: number;
    generatorId: string;
    sellerAddress: string;
    buyerAddress: string;
    volume: string;
    transferDate: Date;
}

export interface EnergyTransferRequestAttrs extends EnergyTransferRequestPublicAttrs {
    createdAt: Date;
    updatedAt: Date;

    certificateId: number | null;
    isCertificatePersisted: boolean;

    validationStatusRecord: Record<string, TransferValidationStatus>;

    /**
     * This property is computed on `validationStatusRecord` update
     * It can be used for queries
     */
    computedValidationStatus: TransferValidationStatus;
}

interface NewAttributesParams {
    buyerAddress: string;
    sellerAddress: string;
    volume: string;
    generatorId: string;
    transferDate: Date;
}

export class EnergyTransferRequest {
    private constructor(private attrs: EnergyTransferRequestAttrs) {}

    public get certificateId() {
        return this.attrs.certificateId;
    }

    public get id() {
        return this.attrs.id;
    }

    public get sites() {
        return {
            buyerAddress: this.attrs.buyerAddress,
            sellerAddress: this.attrs.sellerAddress
        };
    }

    public get volume() {
        return this.attrs.volume;
    }

    public isValid(): boolean {
        return Object.values(this.attrs.validationStatusRecord).every(
            (status) => status === TransferValidationStatus.Valid
        );
    }

    public updateCertificateId(certificateId: number): void {
        this.attrs.certificateId = certificateId;
    }

    public markCertificatePersisted(): void {
        this.attrs.isCertificatePersisted = true;
    }

    public startValidation(validatorNames: string[]): void {
        if (validatorNames.length === 0) {
            this.attrs.computedValidationStatus = TransferValidationStatus.Valid;

            return;
        }

        this.attrs.validationStatusRecord = validatorNames.reduce(
            (status, command) => ({
                ...status,
                [command]: TransferValidationStatus.Pending
            }),
            {} as EnergyTransferRequestAttrs['validationStatusRecord']
        );
    }

    public updateValidationStatus(
        validatorName: string,
        status: TransferValidationStatus
    ): UpdateStatusCode {
        const currentStatus = this.attrs.validationStatusRecord[validatorName];

        if (!currentStatus) {
            return UpdateStatusCode.NoValidator;
        }

        if (currentStatus !== TransferValidationStatus.Pending) {
            /**
             * This may happen randomly if for example we have asymmetric validator,
             * that instantly updates validation status after we start validation
             */

            return UpdateStatusCode.NotPending;
        }

        this.attrs.validationStatusRecord[validatorName] = status;

        const statuses = Object.values(this.attrs.validationStatusRecord);

        if (statuses.some((s) => s === TransferValidationStatus.Error)) {
            this.attrs.computedValidationStatus = TransferValidationStatus.Error;
        } else if (statuses.some((s) => s === TransferValidationStatus.Invalid)) {
            this.attrs.computedValidationStatus = TransferValidationStatus.Invalid;
        } else if (statuses.some((s) => s === TransferValidationStatus.Pending)) {
            this.attrs.computedValidationStatus = TransferValidationStatus.Pending;
        } else if (statuses.every((s) => s === TransferValidationStatus.Valid)) {
            this.attrs.computedValidationStatus = TransferValidationStatus.Valid;
        }

        return UpdateStatusCode.Success;
    }

    public toAttrs(): EnergyTransferRequestAttrs {
        return this.attrs;
    }

    public toPublicAttrs(): EnergyTransferRequestPublicAttrs {
        return {
            buyerAddress: this.attrs.buyerAddress,
            sellerAddress: this.attrs.sellerAddress,
            generatorId: this.attrs.generatorId,
            id: this.attrs.id,
            transferDate: this.attrs.transferDate,
            volume: this.attrs.volume
        };
    }

    public static fromAttrs(attrs: EnergyTransferRequestAttrs): EnergyTransferRequest {
        return new EnergyTransferRequest(attrs);
    }

    public static newAttributes(
        params: NewAttributesParams
    ): Omit<EnergyTransferRequestAttrs, 'id'> {
        return {
            ...params,
            createdAt: new Date(),
            updatedAt: new Date(),
            certificateId: null,
            isCertificatePersisted: false,
            validationStatusRecord: {},
            computedValidationStatus: TransferValidationStatus.Pending
        };
    }
}