import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

export class VerifyTotpDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class EnrolTotpDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class AcceptInviteDto {
  @IsString()
  @MaxLength(512)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  newPassword!: string;
}

export class StartImpersonationDto {
  @IsString()
  accountId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  ticketRef?: string;
}
