export interface PriceAlert {
    id: string;
    price: number;
    direction: 'crossing' | 'above' | 'below';
    triggered: boolean;
    label: string;
}
export declare class AlertManager {
    private alerts;
    private onTrigger;
    constructor(onTrigger: (alert: PriceAlert) => void);
    add(price: number, direction?: PriceAlert['direction'], label?: string): string;
    remove(id: string): void;
    getAll(): PriceAlert[];
    /** Check if price crossed any alerts */
    check(prevPrice: number, currentPrice: number): void;
    clear(): void;
}
