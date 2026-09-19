import { IsOptional, IsString, MaxLength, registerDecorator } from 'class-validator';
import { isValidClassicAddress } from 'xrpl';

function IsClassicAddress(): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isClassicAddress',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: '$property must be a classic XRPL address (X-addresses are not supported)',
      },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidClassicAddress(value),
      },
    });
  };
}

/** POST /v1/accounts. Unknown fields are rejected. */
export class CreateAccountDto {
  @IsClassicAddress()
  address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}
